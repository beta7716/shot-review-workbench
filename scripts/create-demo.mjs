#!/usr/bin/env node
import {mkdir,readFile,writeFile,stat,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {buildTimelineManifest,videoEncoding,fileSHA256} from '../lib/segments.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const project=path.join(ROOT,'examples','demo'),output=path.join(project,'out','master.mp4');
const marker=path.join(project,'out','demo-generated.json');
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--force'))throw new Error('Usage: node scripts/create-demo.mjs [--force]');
const exists=async file=>{try{await stat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
let replaceHash=null;
if(await exists(output)) {
  if(!args.includes('--force')){console.log('Demo master already exists; keeping it. Use --force only to rebuild a generated demo.');process.exit(0);}
  let previous;try{previous=JSON.parse(await readFile(marker,'utf8'));}catch{throw new Error('Refusing to replace an unrecognized master video');}
  if(previous.generator!=='shot-review-workbench-demo-v1'||previous.sha256!==await fileSHA256(output))throw new Error('Refusing to overwrite a video that was not generated here or has changed');
  replaceHash=previous.sha256;
}
const work=await mkdtemp(path.join(os.tmpdir(),'shot-review-demo-'));
const run=(command,argv)=>new Promise((resolve,reject)=>{
  const child=spawn(command,argv,{windowsHide:true,stdio:['ignore','ignore','pipe']});let errors='';
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-12000);});child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`${command} failed (${code}): ${errors}`)));
});
try {
  const timeline=buildTimelineManifest(JSON.parse(await readFile(path.join(project,'timeline.json'),'utf8')));
  const {renderShot}=await import(pathToFileURL(path.join(project,'render.mjs')).href);
  const clips=[];
  for(const shot of timeline.shots) {
    const target=path.join(work,`shot-${shot.id}.mp4`);clips.push(target);
    console.log(`Generating original demo shot ${shot.id}/${timeline.shots.length}`);
    await renderShot({projectRoot:project,shot,outputPath:target,fps:timeline.fps,width:timeline.width,height:timeline.height,encodingArgs:videoEncoding()});
  }
  const list=path.join(work,'concat.txt');
  await writeFile(list,clips.map(file=>`file '${file.replaceAll('\\','/').replaceAll("'","'\\''")}'`).join('\n')+'\n');
  const master=path.join(work,'master.mp4');
  await run('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',list,'-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
    '-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','128k','-t',String(timeline.duration),'-video_track_timescale','30000','-movflags','+faststart',master]);
  await mkdir(path.dirname(output),{recursive:true});
  // On Windows rename cannot replace an existing file; remove only the verified generated output.
  if(await exists(output)) {
    if(!replaceHash||await fileSHA256(output)!==replaceHash)throw new Error('The demo output changed while rendering; leaving the existing video untouched');
    await rm(output);
  }
  // The temporary file may be on another drive, so write the final copy through bytes.
  await writeFile(output,await readFile(master),{flag:'wx'});
  await writeFile(marker,JSON.stringify({generator:'shot-review-workbench-demo-v1',sha256:await fileSHA256(output),totalFrames:timeline.totalFrames,duration:timeline.duration},null,2)+'\n');
  console.log('Demo ready: examples/demo/out/master.mp4 (9 seconds, original graphics, silent AAC audio).');
} finally {await rm(work,{recursive:true,force:true});}
