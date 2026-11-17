import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {loadSegmentManifest} from '../lib/segments.mjs';
import {publishComposedPreview} from '../lib/publish-preview.mjs';

async function fixture(t){
  const project=await mkdtemp(path.join(os.tmpdir(),'review-publish-preview-'));
  t.after(()=>rm(project,{recursive:true,force:true}));
  const dataRoot=path.join(project,'data');
  await writeFile(path.join(project,'timeline.json'),JSON.stringify([{id:1,start:0,end:1}]));
  await writeFile(path.join(project,'main.js'),'first');
  const initial=await loadSegmentManifest(project,{dataRoot});
  await mkdir(initial.cacheDir,{recursive:true});
  await writeFile(initial.shots[0].filePath,'test clip');
  const shot=initial.shots[0];
  await writeFile(initial.statePath,JSON.stringify({version:1,shots:{1:{dependencyKey:shot.dependencyKey,startFrame:shot.startFrame,endFrame:shot.endFrame,fileSHA256:'fixture-hash'}}}));
  await mkdir(path.join(dataRoot,'outputs'));
  const outputPath=path.join(dataRoot,'outputs','verified.mp4');await writeFile(outputPath,'fixture output');
  const result={outputPath,projectRevision:initial.revision,segmentHashes:{1:'fixture-hash'},createdAt:new Date().toISOString()};
  return {project,dataRoot,initial,result};
}

test('CLI composition registration writes the current project preview record',async t=>{
  const {project,dataRoot,initial,result}=await fixture(t);
  const saved=await publishComposedPreview(project,result,{dataRoot});
  assert.equal(saved.output,'outputs/verified.mp4');assert.equal(saved.revision,result.projectRevision);
  const document=JSON.parse(await readFile(path.join(dataRoot,'reviews',`${initial.projectId}-preview.json`),'utf8'));
  assert.deepEqual(document,saved);
});

test('preview registration rejects a path outside the output directory',async t=>{
  const {project,dataRoot,result}=await fixture(t);
  await assert.rejects(publishComposedPreview(project,{...result,outputPath:path.join(project,'outside.mp4')},{dataRoot}),/inside dataRoot\/outputs/);
});

test('preview registration rejects stale segments and old project versions',async t=>{
  const {project,dataRoot,result}=await fixture(t);
  await assert.rejects(publishComposedPreview(project,{...result,projectRevision:'old'},{dataRoot}),/changed after composition/);
  await writeFile(path.join(project,'main.js'),'changed');
  const changed=await loadSegmentManifest(project,{dataRoot});
  await assert.rejects(publishComposedPreview(project,{...result,projectRevision:changed.revision},{dataRoot}),/changed after composition/);
});

test('preview registration rejects a mismatched segment fingerprint',async t=>{
  const {project,dataRoot,result}=await fixture(t);
  await assert.rejects(publishComposedPreview(project,{...result,segmentHashes:{1:'wrong'}},{dataRoot}),/changed after composition/);
});
