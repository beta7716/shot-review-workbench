/** Frame-exact review clips. Source render time is ALWAYS global frame / FPS. */
import fs from 'node:fs';
import {access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DEFAULT_PROJECT, DEFAULT_LIB, loadProjectConfig} from './project-config.mjs';

export const FPS=30, WIDTH=1920, HEIGHT=1080;
const HERE=path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT=path.resolve(HERE,'..');
const PROFILE='h264-high-4.1-yuv420p-bt709-tv-30fps-1920x1080-crf17-fast-bf0-v1';
const JPEG_COLOR='scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,sidedata=mode=delete:type=ICC_PROFILE,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
const DEFAULT_SHARED=['index.html','main.js','media-seek.js','visual-sequences.js','keyframes.json','shots-plan.json','timeline.json','captions.json','captions-display.json','assets','fonts'];
const dependencyHashCache=new Map();
const slash=s=>s.replaceAll('\\','/');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
function stable(value){return JSON.stringify(sort(value));}
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
async function json(file,fallback){try{return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT'&&arguments.length>1)return fallback;throw e;}}
async function exists(file){try{await access(file);return true;}catch{return false;}}
async function atomicJSON(file,value){const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n');await rename(temp,file);}
export async function fileSHA256(file){const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');}
const progress=(options,value,message)=>options.onProgress?.({progress:Math.max(0,Math.min(1,value)),message});

export function buildTimelineManifest(timeline){
  if(!Array.isArray(timeline)||!timeline.length)throw new Error('timeline.json must contain a nonempty shot array');
  const ids=new Set(),last=Number(timeline.at(-1).end),totalFrames=Math.round(last*FPS);
  let previous=0,previousFrame=0;
  const shots=timeline.map((source,i)=>{
    const id=Number(source.id??i+1),start=Number(source.start),end=Number(source.end);
    if(!Number.isSafeInteger(id)||id<1)throw new Error(`Invalid shot ID: ${source.id}`);
    if(ids.has(id))throw new Error(`Duplicate shot ID: ${id}`);ids.add(id);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error(`Invalid shot time: ${id}`);
    if(Math.abs(start-previous)>1e-7)throw new Error(`Timeline must be contiguous (gap/overlap before shot ${id})`);
    const startFrame=previousFrame,endFrame=i===timeline.length-1?totalFrames:Math.ceil(end*FPS-1e-9);
    if(endFrame<=startFrame)throw new Error(`Shot ${id} contains no displayable frame`);
    previous=end;previousFrame=endFrame;
    return {id,title:source.title||`镜头 ${id}`,kind:source.kind||'unknown',start,end,startFrame,endFrame,
      endFrameExclusive:endFrame,frameCount:endFrame-startFrame,duration:(endFrame-startFrame)/FPS};
  });
  const sequences=[];
  for(const shot of shots){let seq=sequences.at(-1);if(!seq||seq.kind!==shot.kind){seq={id:sequences.length+1,kind:shot.kind,startFrame:shot.startFrame,endFrame:shot.endFrame,shotIds:[]};sequences.push(seq);}seq.endFrame=shot.endFrame;seq.shotIds.push(shot.id);shot.sequenceId=seq.id;}
  return {version:1,fps:FPS,width:WIDTH,height:HEIGHT,totalFrames,duration:totalFrames/FPS,sourceDuration:last,shots,sequences};
}

export function selectShotIds(manifest,shotIds){
  if(!Array.isArray(shotIds)||!shotIds.length)throw new Error('Select an explicit nonempty array of shot IDs; no implicit full-film rendering');
  const selected=new Set(shotIds.map(Number));
  for(const id of selected)if(!Number.isSafeInteger(id)||!manifest.shots.some(s=>s.id===id))throw new Error(`Unknown shot ID: ${id}`);
  return manifest.shots.filter(s=>selected.has(s.id));
}

async function listDependencyFiles(root,relative,verifyFreshHash=false){
  const full=path.resolve(root,relative),rel=slash(path.relative(root,full));
  if(rel.startsWith('../')||path.isAbsolute(rel))throw new Error(`Dependency escapes project: ${relative}`);
  let info;try{info=await stat(full);}catch(e){if(e.code==='ENOENT')return [{path:rel,sha256:'MISSING'}];throw e;}
  if(info.isFile()){
    const signature=`${info.size}:${info.mtimeMs}:${info.ctimeMs}`,previous=dependencyHashCache.get(full);
    const sha256=!verifyFreshHash&&previous?.signature===signature?previous.sha256:await fileSHA256(full);
    dependencyHashCache.set(full,{signature,sha256});return [{path:rel,sha256}];
  }
  if(!info.isDirectory())throw new Error(`Unsupported dependency: ${relative}`);
  const files=[];
  for(const item of (await readdir(full,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(item.isSymbolicLink())throw new Error(`Symbolic-link dependency is unsupported: ${rel}/${item.name}`);
    files.push(...await listDependencyFiles(root,path.join(rel,item.name),verifyFreshHash));
  }
  return files;
}
function editAffects(edit,shot){
  if(edit.shotId!=null&&Number(edit.shotId)!==shot.id)return false;
  if(edit.start!=null&&Number(edit.start)>shot.end)return false;
  if(edit.end!=null&&Number(edit.end)<shot.start)return false;
  return true;
}
async function dependencies(projectRoot,manifest,options,projectConfig){
  const dependenciesFile=options.dependenciesFile?path.resolve(projectRoot,options.dependenciesFile):path.join(projectRoot,'segment-dependencies.json');
  const declared=await json(dependenciesFile,{});
  const sharedPaths=declared.shared??DEFAULT_SHARED;
  if(!Array.isArray(sharedPaths))throw new Error('segment-dependencies shared must be an array');
  const shared=[];
  for(const rel of new Set([...sharedPaths,'review-project.json',...(projectConfig.renderAdapter?[projectConfig.renderAdapter]:[])]))shared.push(...await listDependencyFiles(projectRoot,rel,options.verifyFreshHash));
  const editsFile=options.editsFile||'editor-edits.json';
  const editData=await json(path.resolve(projectRoot,editsFile),[]),edits=Array.isArray(editData)?editData:(editData?.edits||[]);
  const warnings=[];
  if(declared.shared)warnings.push('Explicit dependency manifest overrides automatic shared-file discovery; its author must list every visual dependency.');
  const keys=new Map();
  for(const shot of manifest.shots){
    const config=declared.shots?.[shot.id]||{},files=[];
    for(const rel of config.files||[])files.push(...await listDependencyFiles(projectRoot,rel,options.verifyFreshHash));
    const scoped=edits.filter(e=>editAffects(e,shot));
    for(const edit of scoped){const source=edit.assetPath||edit.assetUrl;if(!source)continue;
      if(/^https?:|^data:|^blob:/i.test(source)){warnings.push(`Shot ${shot.id}: remote/inline asset freshness cannot be independently checked.`);files.push({path:source,sha256:'URL_ONLY'});}
      else if(!source.startsWith('/'))files.push(...await listDependencyFiles(projectRoot,source.split('?')[0],options.verifyFreshHash));
      else{warnings.push(`Shot ${shot.id}: server-root asset path is not locally fingerprinted: ${source}`);files.push({path:source,sha256:'URL_ONLY'});}
    }
    keys.set(shot.id,hash({profile:PROFILE,query:options.query??'edits=editor-edits.json',shared,files,edits:scoped,
      revision:options.shotRevisions?.[shot.id]??config.revision??0,shot}));
  }
  return {keys,sharedFingerprint:hash(shared),warnings:[...new Set(warnings)],explicitDependencyManifest:Boolean(declared.shared)};
}

export async function loadSegmentManifest(projectRoot=process.env.VIDEO_PROJECT_ROOT||DEFAULT_PROJECT,options={}){
  projectRoot=path.resolve(projectRoot);
  const projectConfig=await loadProjectConfig(projectRoot);
  const base=buildTimelineManifest(await json(path.join(projectRoot,'timeline.json')));
  const dataRoot=path.resolve(options.dataRoot||process.env.VIDEO_REVIEW_DATA_ROOT||path.join(TOOL_ROOT,'data'));
  const projectId=`${path.basename(projectRoot).replace(/[^a-zA-Z0-9_-]/g,'_')}-${hash(projectRoot.toLowerCase()).slice(0,10)}`;
  const cacheDir=path.join(dataRoot,'segments',projectId),state=await json(path.join(cacheDir,'manifest.json'),{version:1,shots:{}});
  const deps=await dependencies(projectRoot,base,options,projectConfig);
  const shots=[];
  for(const shot of base.shots){
    const entry=state.shots?.[shot.id],fileName=entry?.fileName||`shot-${String(shot.id).padStart(3,'0')}.mp4`,filePath=path.resolve(cacheDir,fileName);
    if(slash(path.relative(cacheDir,filePath)).startsWith('../')||path.isAbsolute(path.relative(cacheDir,filePath)))throw new Error(`Invalid cache path for shot ${shot.id}`);
    const available=await exists(filePath),dependencyKey=deps.keys.get(shot.id);
    const reasons=[];
    if(available&&!entry)reasons.push('untracked-cache');
    if(entry?.dependencyKey!==dependencyKey&&available)reasons.push('dependencies-changed');
    if(entry&&(entry.startFrame!==shot.startFrame||entry.endFrame!==shot.endFrame))reasons.push('frame-boundaries-changed');
    shots.push({...shot,filePath,url:`/files/segments/${projectId}/${slash(fileName)}`,available,stale:available&&reasons.length>0,
      staleReasons:reasons,origin:entry?.origin??null,dependencyKey,cachedDependencyKey:entry?.dependencyKey??null,
      fileSHA256:entry?.fileSHA256??null,renderedAt:entry?.renderedAt??null});
  }
  const revision=hash({profile:PROFILE,shots:shots.map(s=>({id:s.id,startFrame:s.startFrame,endFrame:s.endFrame,dependencyKey:s.dependencyKey}))});
  return {...base,...projectConfig,shots,revision,projectRoot,projectId,dataRoot,cacheDir,statePath:path.join(cacheDir,'manifest.json'),
    initialized:Boolean(state.baseline),baseline:state.baseline??null,baselineVideoUrl:state.baseline?`/files/segments/${projectId}/${slash(path.relative(cacheDir,state.baseline.frozenPath))}`:null,
    sharedFingerprint:deps.sharedFingerprint,warnings:deps.warnings,explicitDependencyManifest:deps.explicitDependencyManifest,
    availableCount:shots.filter(s=>s.available).length,staleShotIds:shots.filter(s=>s.stale).map(s=>s.id),
    missingShotIds:shots.filter(s=>!s.available).map(s=>s.id)};
}

async function withLock(cacheDir,action){
  await mkdir(cacheDir,{recursive:true});const lockPath=path.join(cacheDir,'.operation.lock');let lock;
  // A fatal error in the existing browser helper can terminate its isolated worker.
  // Reclaim only a lock whose recorded process has actually exited.
  const previous=await json(lockPath,null);
  if(previous?.pid){let alive=true;try{process.kill(Number(previous.pid),0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(!alive)await rm(lockPath,{force:true});}
  try{lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}
  catch(e){if(e.code==='EEXIST')throw new Error('Another segment operation owns this project cache; wait for it to finish.');throw e;}
  try{return await action();}finally{await lock.close();await rm(lockPath,{force:true});}
}
async function command(executable,args,{onLine}={}){
  const child=spawn(executable,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',errors='',partial='';
  child.stdout.on('data',chunk=>{const text=chunk.toString();output+=text;partial+=text;const lines=partial.split(/\r?\n/);partial=lines.pop();for(const line of lines)onLine?.(line);});
  child.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-12000);});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(code!==0)throw new Error(`${executable} exited ${code}: ${errors}`);
  return {stdout:output,stderr:errors};
}
export async function probeMedia(file){return JSON.parse((await command('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',file])).stdout);}
export function videoEncoding(){return ['-c:v','libx264','-preset','fast','-crf','17','-profile:v','high','-level:v','4.1','-pix_fmt','yuv420p','-r',String(FPS),'-g','60','-keyint_min','1','-sc_threshold','0','-bf','0','-threads','4','-color_range','tv','-colorspace','bt709','-color_trc','bt709','-color_primaries','bt709'];}
async function verifyClip(file,frameCount){const info=await probeMedia(file),video=info.streams.find(s=>s.codec_type==='video');
  if(!video||video.codec_name!=='h264'||video.profile!=='High'||video.level!==41||video.has_b_frames!==0||video.width!==WIDTH||video.height!==HEIGHT||video.avg_frame_rate!=='30/1'||Number(video.nb_read_frames)!==frameCount||video.pix_fmt!=='yuv420p'||video.color_space!=='bt709'||video.color_range!=='tv')throw new Error(`Segment verification failed (${frameCount} frames and the documented H.264 profile expected): ${file}`);
  return video;
}
async function cacheEntry(shot,origin,extra={}){return {startFrame:shot.startFrame,endFrame:shot.endFrame,dependencyKey:shot.dependencyKey,
  origin,renderedAt:new Date().toISOString(),fileSHA256:await fileSHA256(shot.filePath),profile:PROFILE,...extra};}
/** Publish immutable files, then switch the single manifest pointer. Old clips stay intact. */
export async function commitCacheGeneration(cacheDir,stagingDir,generationName,state,{writeState=atomicJSON}={}){
  if(path.basename(generationName)!==generationName||!/^generation-[a-zA-Z0-9-]+$/.test(generationName))throw new Error('Invalid cache generation name');
  const target=path.join(cacheDir,generationName);
  await rename(stagingDir,target);
  try{await writeState(path.join(cacheDir,'manifest.json'),state);}
  catch(error){await rm(target,{recursive:true,force:true});throw error;}
  return target;
}
function affectedSummary(manifest,selected){const ids=new Set(selected.map(s=>s.id));const sequences=manifest.sequences.filter(s=>s.shotIds.some(id=>ids.has(id)));return {selectedShotIds:[...ids],affectedSequenceIds:sequences.map(s=>s.id),recommendedShotIds:[...new Set(sequences.flatMap(s=>s.shotIds))],
  dependencyStaleShotIds:manifest.staleShotIds,unselectedStaleShotIds:manifest.staleShotIds.filter(id=>!ids.has(id))};}

export async function initializeSegmentCache(projectRoot=process.env.VIDEO_PROJECT_ROOT||DEFAULT_PROJECT,options={}){
  const initial=await loadSegmentManifest(projectRoot,options);
  return withLock(initial.cacheDir,async()=>{
    const manifest=await loadSegmentManifest(projectRoot,options);
    if(manifest.initialized&&!options.force){progress(options,1,'分段缓存已初始化，保留现有片段');return manifest;}
    const sourceVideo=path.resolve(options.sourceVideo||path.join(manifest.projectRoot,manifest.masterVideo));
    if(sourceVideo===path.join(manifest.cacheDir,'baseline.mp4'))throw new Error('Migration source must be the delivered original, outside its cache');
    const sourceInfo=await probeMedia(sourceVideo),video=sourceInfo.streams.find(s=>s.codec_type==='video');
    if(video?.width!==WIDTH||video?.height!==HEIGHT||video?.avg_frame_rate!=='30/1'||Number(video?.nb_read_frames)!==manifest.totalFrames)throw new Error('Delivered master must match the fixed 1080p/30fps timeline frame count');
    if(!sourceInfo.streams.some(s=>s.codec_type==='audio'))throw new Error('Delivered master has no original audio track');
    const generationName=`generation-${randomUUID()}`,work=path.join(manifest.cacheDir,`.migration-${randomUUID()}`);await mkdir(work);
    try{
      progress(options,.01,'冻结已交付成片并记录指纹（首次迁移，不是源码重渲染）');
      const sourceHash=await fileSHA256(sourceVideo),frozen=path.join(work,'baseline.mp4');await copyFile(sourceVideo,frozen);
      if(await fileSHA256(frozen)!==sourceHash)throw new Error('Baseline copy fingerprint mismatch');
      const boundaries=manifest.shots.slice(1).map(s=>s.startFrame),times=boundaries.map(f=>(f/FPS).toFixed(9));
      await command('ffmpeg',['-y','-hide_banner','-loglevel','error','-i',frozen,'-map','0:v:0','-an','-vf',`scale=${WIDTH}:${HEIGHT}:in_range=tv:out_range=tv,format=yuv420p`,
        ...videoEncoding(),...(times.length?['-force_key_frames',times.join(',')]:[]),'-frames:v',String(manifest.totalFrames),'-progress','pipe:1','-nostats','-f','segment',...(boundaries.length?['-segment_frames',boundaries.join(',')]:[]),
        '-segment_start_number','1','-reset_timestamps','1','-segment_format_options','video_track_timescale=30000:movflags=+faststart',path.join(work,'part-%03d.mp4')],
        {onLine:line=>{const match=/^frame=(\d+)/.exec(line);if(match)progress(options,.03+Number(match[1])/manifest.totalFrames*.72,'首次迁移：按全局帧边界切分已交付成片');}});
      const entries={};
      for(let i=0;i<manifest.shots.length;i++){
        const shot=manifest.shots[i],part=path.join(work,`part-${String(i+1).padStart(3,'0')}.mp4`);
        await verifyClip(part,shot.frameCount);
        const filename=`shot-${String(shot.id).padStart(3,'0')}.mp4`,staged=path.join(work,filename);await rename(part,staged);
        entries[shot.id]=await cacheEntry({...shot,filePath:staged},'migrated-master',{fileName:`${generationName}/${filename}`,baselineSHA256:sourceHash,baselineSourceMatching:'initial-migration-assumption-not-source-rerender'});
        progress(options,.76+(i+1)/manifest.shots.length*.22,`核验迁移片段 ${i+1}/${manifest.shots.length}`);
      }
      await commitCacheGeneration(manifest.cacheDir,work,generationName,{version:1,profile:PROFILE,baseline:{sourceVideo,sha256:sourceHash,frozenPath:path.join(manifest.cacheDir,generationName,'baseline.mp4'),
        migratedAt:new Date().toISOString(),migration:true,sourceRerendered:false,totalFrames:manifest.totalFrames},shots:entries});
      progress(options,1,'首次迁移完成：片段和原音轨基线已冻结');return await loadSegmentManifest(projectRoot,options);
    }finally{await rm(work,{recursive:true,force:true});}
  });
}

/** Internal export used by isolated renderer worker; never call with implicit/all IDs. */
export async function renderSelectedSegmentsWorker(projectRoot,options={}){
  const initial=await loadSegmentManifest(projectRoot,options),selected=selectShotIds(initial,options.shotIds);
  return withLock(initial.cacheDir,async()=>{
    const manifest=await loadSegmentManifest(projectRoot,options),shots=selectShotIds(manifest,options.shotIds),summary=affectedSummary(manifest,shots);
    const state=await json(manifest.statePath,{version:1,profile:PROFILE,shots:{}});
    let pageModule,adapter;
    if(manifest.renderAdapter){
      adapter=await import(pathToFileURL(path.join(manifest.projectRoot,manifest.renderAdapter)).href);
      if(typeof adapter.renderShot!=='function')throw new Error('renderAdapter must export async renderShot(options)');
    }else{
      const helper=path.join(path.resolve(options.libRoot||process.env.LEMO_OPUSCAR_HOME||DEFAULT_LIB),'core/render/page.mjs');
      if(!await exists(helper))throw new Error('No renderAdapter configured. Set LEMO_OPUSCAR_HOME to an installed Lemo-Opuscar library, or provide review-project.json renderAdapter.');
      pageModule=await import(pathToFileURL(helper).href);
    }
    let browser,page;const generationName=`generation-${randomUUID()}`,work=path.join(manifest.cacheDir,`.render-${randomUUID()}`);await mkdir(work);
    const total=shots.reduce((sum,s)=>sum+s.frameCount,0);let done=0;
    try{
      if(pageModule){
        ({browser,page}=await pageModule.openDemo(manifest.projectRoot,{w:WIDTH,h:HEIGHT,q:options.query??'edits=editor-edits.json'}));
        const canvas=await page.evaluate(()=>({width:document.querySelector('canvas')?.width,height:document.querySelector('canvas')?.height,preview:window.PREVIEW_INFO?.().preview}));
        if(canvas.width!==WIDTH||canvas.height!==HEIGHT||canvas.preview)throw new Error('Export refused: renderer is in scaled editor preview mode');
      }
      for(const shot of shots){
        const target=path.join(work,path.basename(shot.filePath));
        if(adapter){
          await adapter.renderShot({projectRoot:manifest.projectRoot,shot,outputPath:target,fps:FPS,width:WIDTH,height:HEIGHT,encodingArgs:videoEncoding(),onProgress:options.onProgress});
          done+=shot.frameCount;progress(options,done/total*.92,`重渲染选中镜头 ${shot.id}`);
        }else{
        const encoder=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','image2pipe','-framerate',String(FPS),'-c:v','mjpeg','-i','-','-an','-vf',JPEG_COLOR,...videoEncoding(),'-video_track_timescale','30000','-movflags','+faststart',target],{windowsHide:true,stdio:['pipe','ignore','pipe']});
        let errors='';encoder.stderr.on('data',chunk=>{errors=(errors+chunk.toString()).slice(-12000);});
        encoder.stdin.on('error',()=>{}); // write callbacks below receive the actionable pipe error
        const closed=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(new Error(`Segment encoder failed: ${errors}`)));});
        // Listen immediately: a closed encoder must not become an unhandled rejection.
        closed.catch(()=>{});
        try{
          for(let frame=shot.startFrame;frame<shot.endFrame;frame++){
            await page.evaluate(time=>window.render(time),frame/FPS);
            const image=await page.screenshot({type:'jpeg',quality:95});
            await new Promise((resolve,reject)=>encoder.stdin.write(image,error=>error?reject(error):resolve()));
            done++;if(done%10===0||frame===shot.endFrame-1)progress(options,done/total*.92,`重渲染选中镜头 ${shot.id} · 全局帧 ${frame}`);
          }
          encoder.stdin.end();await closed;
        }catch(e){encoder.kill();await closed.catch(()=>{});throw e;}
        }
        await verifyClip(target,shot.frameCount);
        const after=await loadSegmentManifest(projectRoot,options);
        if(after.shots.find(s=>s.id===shot.id)?.dependencyKey!==shot.dependencyKey)throw new Error(`Shot ${shot.id} dependencies changed during rendering; cache was not committed`);
        state.shots??={};state.shots[shot.id]=await cacheEntry({...shot,filePath:target},'source-render',{fileName:`${generationName}/${path.basename(target)}`,absoluteTime:true,firstGlobalFrame:shot.startFrame,lastGlobalFrame:shot.endFrame-1});
      }
      const after=await loadSegmentManifest(projectRoot,options);
      if(shots.some(shot=>after.shots.find(s=>s.id===shot.id)?.dependencyKey!==shot.dependencyKey))throw new Error('Selected shot dependencies changed during rendering; the whole batch was not committed');
      await commitCacheGeneration(manifest.cacheDir,work,generationName,state);
      progress(options,1,'仅选中镜头重渲染完成');return {...summary,renderedShotIds:shots.map(s=>s.id),manifest:await loadSegmentManifest(projectRoot,options)};
    }finally{await browser?.close();pageModule?.closeServer();await rm(work,{recursive:true,force:true});}
  });
}

/** Rendering is isolated because the existing Lemo page helper exits on fatal browser errors. */
export async function renderSelectedSegments(projectRoot=process.env.VIDEO_PROJECT_ROOT||DEFAULT_PROJECT,options={}){
  const manifest=await loadSegmentManifest(projectRoot,options);selectShotIds(manifest,options.shotIds);
  const safe={...options};delete safe.onProgress;
  const result=await command(process.execPath,[path.join(TOOL_ROOT,'scripts/segments.mjs'),'render-worker','--project',path.resolve(projectRoot),'--options-json',JSON.stringify(safe)],{onLine:line=>{
    try{const event=JSON.parse(line);if(event.type==='progress')options.onProgress?.(event);}
    catch{}
  }});
  const events=result.stdout.trim().split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}});
  const final=events.findLast(e=>e?.type==='result');if(!final)throw new Error(`Renderer worker produced no result: ${result.stderr}`);return final.result;
}

export async function composeSegments(projectRoot=process.env.VIDEO_PROJECT_ROOT||DEFAULT_PROJECT,options={}){
  const initial=await loadSegmentManifest(projectRoot,options);
  return withLock(initial.cacheDir,async()=>{
    const manifest=await loadSegmentManifest(projectRoot,options);
    if(manifest.missingShotIds.length)throw new Error(`Missing cache clips: ${manifest.missingShotIds.join(', ')}. Initialize or explicitly render them first.`);
    if(manifest.staleShotIds.length&&!options.allowStaleReuse)throw new Error(`Stale cache clips: ${manifest.staleShotIds.join(', ')}. Render explicit IDs, or explicitly allow stale reuse.`);
    if(!manifest.baseline?.frozenPath)throw new Error('Initialize and freeze the original master audio before composing');
    progress(options,.02,'核对所有缓存片段和冻结的原音轨');
    if(await fileSHA256(manifest.baseline.frozenPath)!==manifest.baseline.sha256)throw new Error('Frozen baseline fingerprint changed; original audio cannot be trusted');
    for(let i=0;i<manifest.shots.length;i++){
      const shot=manifest.shots[i];if(!shot.fileSHA256||await fileSHA256(shot.filePath)!==shot.fileSHA256)throw new Error(`Cache file fingerprint mismatch: shot ${shot.id}`);
      await verifyClip(shot.filePath,shot.frameCount);progress(options,.03+(i+1)/manifest.shots.length*.35,`核对片段 ${shot.id}`);
    }
    const outputDir=path.join(manifest.dataRoot,'outputs');await mkdir(outputDir,{recursive:true});
    const requested=String(options.outputName||`review-segments-${new Date().toISOString().replace(/[:.]/g,'-')}`);
    if(path.basename(requested)!==requested||/[<>:"/\\|?*]/.test(requested))throw new Error('Output name must be a plain filename');
    const name=requested.toLowerCase().endsWith('.mp4')?requested:`${requested}.mp4`,outputPath=path.join(outputDir,name);
    if(await exists(outputPath))throw new Error(`Output already exists; choose a new name: ${name}`);
    const work=path.join(manifest.cacheDir,`.compose-${randomUUID()}`);await mkdir(work);
    try{
      const list=path.join(work,'concat.txt');
      await writeFile(list,manifest.shots.map(s=>`file '${slash(s.filePath).replaceAll("'","'\\''")}'`).join('\n')+'\n');
      const temp=path.join(work,'final.mp4');
      progress(options,.4,'拼接缓存画面并复制整条原 AAC 音轨');
      await command('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-i',manifest.baseline.frozenPath,
        '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','copy','-video_track_timescale','30000','-movflags','+faststart','-progress','pipe:1','-nostats',temp],
        {onLine:line=>{const m=/^frame=(\d+)/.exec(line);if(m)progress(options,.4+Number(m[1])/manifest.totalFrames*.3,'拼接画面，原音轨仅复制一次');}});
      await verifyClip(temp,manifest.totalFrames);
      const audioHash=async file=>(await command('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-c','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
      const baselineAudioHash=await audioHash(manifest.baseline.frozenPath),outputAudioHash=await audioHash(temp);
      if(baselineAudioHash!==outputAudioHash)throw new Error('Original audio packet fingerprint was not preserved');
      const after=await loadSegmentManifest(projectRoot,options);
      if(after.revision!==manifest.revision)throw new Error('Project content changed during composition; retry against the current revision');
      await rename(temp,outputPath);
      const renderedShotIds=manifest.shots.filter(s=>s.origin==='source-render').map(s=>s.id),reusedShotIds=manifest.shots.filter(s=>s.origin!=='source-render').map(s=>s.id);
      const report={outputPath,url:`/files/outputs/${encodeURIComponent(name)}`,projectRevision:manifest.revision,totalFrames:manifest.totalFrames,duration:manifest.duration,fps:FPS,width:WIDTH,height:HEIGHT,
        reusedShotIds,renderedShotIds,staleReusedShotIds:manifest.staleShotIds,segmentHashes:Object.fromEntries(manifest.shots.map(shot=>[shot.id,shot.fileSHA256])),audioCopied:true,audioPacketSHA256:outputAudioHash,baselineSHA256:manifest.baseline.sha256,
        sourceRerenderedDuringCompose:false,subtitlesModified:false,createdAt:new Date().toISOString()};
      await atomicJSON(`${outputPath}.json`,report);progress(options,1,'全片合成完成：音轨指纹一致');return report;
    }finally{await rm(work,{recursive:true,force:true});}
  });
}
