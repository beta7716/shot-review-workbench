import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {buildTimelineManifest, selectShotIds, loadSegmentManifest,composeSegments,commitCacheGeneration} from '../lib/segments.mjs';

test('global frame intervals have no missing or repeated boundary frames', () => {
  const m=buildTimelineManifest([
    {id:1,start:0,end:2.681,kind:'hook'},
    {id:2,start:2.681,end:3.924,kind:'hook'},
    {id:3,start:3.924,end:4.021,kind:'end'},
  ]);
  assert.deepEqual(m.shots.map(s=>[s.startFrame,s.endFrame]),[[0,81],[81,118],[118,121]]);
  assert.equal(m.totalFrames,121);
  assert.deepEqual(m.sequences.map(s=>s.shotIds),[[1,2],[3]]);
  for(const s of m.shots) for(let f=s.startFrame;f<s.endFrame;f++) {
    assert.ok(f/30>=s.start-1e-10);
    assert.ok(f/30<s.end);
  }
});

test('exact decimal frame boundaries do not acquire a phantom extra frame',()=>{
  const m=buildTimelineManifest([{id:1,start:0,end:1.1},{id:2,start:1.1,end:2}]);
  assert.equal(m.shots[0].endFrame,33);
  assert.equal(m.shots[1].startFrame,33);
});

test('rejects gaps, duplicate IDs and shots with no displayable frame',()=>{
  assert.throws(()=>buildTimelineManifest([{id:1,start:0,end:1},{id:2,start:1.01,end:2}]),/gap|contiguous/i);
  assert.throws(()=>buildTimelineManifest([{id:1,start:0,end:1},{id:1,start:1,end:2}]),/duplicate/i);
  assert.throws(()=>buildTimelineManifest([{id:1,start:0,end:.001},{id:2,start:.001,end:.002},{id:3,start:.002,end:1}]),/frame/i);
});

test('only explicit valid shot IDs are selected, in timeline order',()=>{
  const m=buildTimelineManifest([{id:1,start:0,end:1},{id:2,start:1,end:2},{id:3,start:2,end:3}]);
  assert.deepEqual(selectShotIds(m,[3,1,3]).map(s=>s.id),[1,3]);
  assert.throws(()=>selectShotIds(m,[]),/explicit|select/i);
  assert.throws(()=>selectShotIds(m,[99]),/unknown/i);
  assert.throws(()=>selectShotIds(m,'all'),/explicit|array/i);
});

test('cache invalidation distinguishes shared dependencies and shot-specific edits',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'opuscar-segments-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const project=path.join(dir,'project'),dataRoot=path.join(dir,'data');
  await mkdir(project);
  await writeFile(path.join(project,'timeline.json'),JSON.stringify([{id:1,start:0,end:1,kind:'x'},{id:2,start:1,end:2,kind:'x'}]));
  await writeFile(path.join(project,'main.js'),'original shared code');
  const initial=await loadSegmentManifest(project,{dataRoot});
  assert.ok(initial.shots.every(s=>!s.available));
  await mkdir(initial.cacheDir,{recursive:true});
  const entries={};
  for(const s of initial.shots){
    await writeFile(s.filePath,'test clip');
    entries[s.id]={dependencyKey:s.dependencyKey,startFrame:s.startFrame,endFrame:s.endFrame,origin:'source-render',fileSHA256:'unverified-test'};
  }
  await writeFile(path.join(initial.cacheDir,'manifest.json'),JSON.stringify({version:1,shots:entries}));
  const cached=await loadSegmentManifest(project,{dataRoot});
  assert.ok(cached.shots.every(s=>s.available&&!s.stale));
  assert.equal(initial.revision,cached.revision,'cache availability must not change project content revision');
  await writeFile(path.join(project,'editor-edits.json'),JSON.stringify({edits:[{shotId:2,componentId:'x',assetPath:'replacement.png'}]}));
  await writeFile(path.join(project,'replacement.png'),'image one');
  const edited=await loadSegmentManifest(project,{dataRoot});
  assert.equal(edited.shots[0].stale,false);
  assert.equal(edited.shots[1].stale,true);
  assert.notEqual(initial.revision,edited.revision);
  await assert.rejects(composeSegments(project,{dataRoot}),/stale cache clips: 2/i);
  await writeFile(path.join(project,'main.js'),'changed shared code');
  const shared=await loadSegmentManifest(project,{dataRoot});
  assert.ok(shared.shots.every(s=>s.stale));
});

test('an asset change invalidates a scoped edit even when the edit JSON is unchanged',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'opuscar-dependency-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'timeline.json'),JSON.stringify([{id:1,start:0,end:1},{id:2,start:1,end:2}]));
  await writeFile(path.join(dir,'editor-edits.json'),JSON.stringify({edits:[{shotId:2,assetPath:'editor-assets/a.png'}]}));
  await mkdir(path.join(dir,'editor-assets'));
  await writeFile(path.join(dir,'editor-assets/a.png'),'first');
  const a=await loadSegmentManifest(dir,{dataRoot:path.join(dir,'cache')});
  await writeFile(path.join(dir,'editor-assets/a.png'),'second');
  const b=await loadSegmentManifest(dir,{dataRoot:path.join(dir,'cache')});
  assert.equal(a.shots[0].dependencyKey,b.shots[0].dependencyKey);
  assert.notEqual(a.shots[1].dependencyKey,b.shots[1].dependencyKey);
});

test('compose refuses missing clips without silently rendering anything',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'opuscar-missing-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(path.join(dir,'timeline.json'),JSON.stringify([{id:1,start:0,end:1}]));
  await assert.rejects(composeSegments(dir,{dataRoot:path.join(dir,'cache')}),/Missing cache clips: 1/);
  const after=await loadSegmentManifest(dir,{dataRoot:path.join(dir,'cache')});
  assert.equal(after.availableCount,0);
});

test('failed generation manifest commit leaves every prior clip and manifest usable',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'opuscar-transaction-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const stage=path.join(dir,'.stage');await mkdir(stage);
  const previous={version:1,shots:{1:{fileName:'old-1.mp4'},2:{fileName:'old-2.mp4'}}};
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(previous));
  await writeFile(path.join(dir,'old-1.mp4'),'prior one');await writeFile(path.join(dir,'old-2.mp4'),'prior two');
  await writeFile(path.join(stage,'shot-001.mp4'),'new one');await writeFile(path.join(stage,'shot-002.mp4'),'new two');
  await assert.rejects(commitCacheGeneration(dir,stage,'generation-test',{shots:{}},{writeState:async()=>{throw new Error('disk manifest commit failed');}}),/disk manifest commit failed/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')),previous);
  assert.equal(await readFile(path.join(dir,'old-1.mp4'),'utf8'),'prior one');
  assert.equal(await readFile(path.join(dir,'old-2.mp4'),'utf8'),'prior two');
  await assert.rejects(readFile(path.join(dir,'generation-test/shot-001.mp4')),/ENOENT/);
});

test('one manifest switch publishes a complete immutable multi-shot generation',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'opuscar-publish-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const stage=path.join(dir,'.stage');await mkdir(stage);
  await writeFile(path.join(stage,'shot-001.mp4'),'new one');await writeFile(path.join(stage,'shot-002.mp4'),'new two');
  const state={version:1,shots:{1:{fileName:'generation-two/shot-001.mp4'},2:{fileName:'generation-two/shot-002.mp4'}}};
  await commitCacheGeneration(dir,stage,'generation-two',state);
  const published=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  assert.deepEqual(published,state);
  assert.equal(await readFile(path.join(dir,published.shots[1].fileName),'utf8'),'new one');
  assert.equal(await readFile(path.join(dir,published.shots[2].fileName),'utf8'),'new two');
});
