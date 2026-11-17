import path from 'node:path';
import {mkdir,stat,writeFile,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {loadSegmentManifest} from './segments.mjs';

/** Register a verified composition so browser review follows CLI exports too. */
export async function publishComposedPreview(projectRoot,result,options={}) {
  const current=await loadSegmentManifest(projectRoot,options);
  const output=path.resolve(result?.outputPath||result?.output||'');
  const outputs=path.resolve(current.dataRoot,'outputs');
  if(path.dirname(output)!==outputs||!/^[\p{L}\p{N}._-]+\.mp4$/u.test(path.basename(output)))throw new Error('Composition output must be an MP4 directly inside dataRoot/outputs');
  if(!(await stat(output)).isFile())throw new Error('Composition output is not a file');
  if(current.revision!==result.projectRevision||!result.segmentHashes||current.shots.some(shot=>!shot.available||shot.stale||!shot.fileSHA256||result.segmentHashes[shot.id]!==shot.fileSHA256))throw new Error('Project or segments changed after composition; preview was not registered');
  const saved={version:1,revision:current.revision,output:`outputs/${path.basename(output)}`,
    segmentHashes:Object.fromEntries(current.shots.map(shot=>[shot.id,shot.fileSHA256])),createdAt:result.createdAt||new Date().toISOString()};
  const target=path.join(current.dataRoot,'reviews',`${current.projectId.replace(/[^a-zA-Z0-9_-]/g,'_')}-preview.json`),temporary=`${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target),{recursive:true});
  try{await writeFile(temporary,JSON.stringify(saved,null,2),'utf8');await rename(temporary,target);}
  catch(error){await unlink(temporary).catch(()=>{});throw error;}
  return saved;
}
