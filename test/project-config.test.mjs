import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {loadProjectConfig,DEFAULT_PROJECT} from '../lib/project-config.mjs';
import {loadSegmentManifest} from '../lib/segments.mjs';

test('portable defaults refer to the bundled example, without a personal project',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-config-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config=await loadProjectConfig(dir);
  assert.equal(config.title,path.basename(dir));
  assert.equal(config.masterVideo,'out/master.mp4');
  assert.equal(config.renderAdapter,null);
  assert.equal(DEFAULT_PROJECT.replaceAll('\\','/').endsWith('/examples/demo'),true);
});

test('project configuration validates file paths and supported output profile',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-config-validation-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const write=value=>writeFile(path.join(dir,'review-project.json'),JSON.stringify(value));
  for(const invalid of [{masterVideo:'../private.mp4'},{masterVideo:'C:\\private.mp4'},{renderAdapter:'/outside.mjs'},{renderAdapter:'renderer.exe'},{width:1280},{fps:60},{title:[]},{version:9}]){
    await write(invalid);await assert.rejects(loadProjectConfig(dir));
  }
  await write({version:1,title:'Demo',masterVideo:'out/custom.mp4',renderAdapter:'render.mjs'});
  const config=await loadProjectConfig(dir);
  assert.equal(config.title,'Demo');assert.equal(config.renderAdapter,'render.mjs');
});

test('adapter code is fingerprinted even with an explicit shared dependency list',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-adapter-deps-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'review-project.json'),JSON.stringify({renderAdapter:'render.mjs'}));
  await writeFile(path.join(dir,'timeline.json'),JSON.stringify([{id:1,start:0,end:1}]));
  await writeFile(path.join(dir,'segment-dependencies.json'),JSON.stringify({shared:[]}));
  await writeFile(path.join(dir,'render.mjs'),'export const renderShot=async()=>{};');
  const before=await loadSegmentManifest(dir,{dataRoot:path.join(dir,'data')});
  await writeFile(path.join(dir,'render.mjs'),'export const renderShot=async()=>{return 1;};');
  const after=await loadSegmentManifest(dir,{dataRoot:path.join(dir,'data')});
  assert.notEqual(before.revision,after.revision);
});
