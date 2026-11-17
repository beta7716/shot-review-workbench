import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {getScene} from '../examples/demo/scene.mjs';
import {rasterizeScene} from '../examples/demo/render.mjs';
import {buildTimelineManifest,loadSegmentManifest} from '../lib/segments.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../examples/demo');
test('demo exposes three contiguous independently configured source shots',async()=>{
  const timeline=buildTimelineManifest(JSON.parse(await readFile(path.join(project,'timeline.json'),'utf8')));
  assert.equal(timeline.totalFrames,270);assert.equal(timeline.duration,9);
  assert.deepEqual(timeline.shots.map(shot=>[shot.startFrame,shot.endFrame]),[[0,90],[90,180],[180,270]]);
  const manifest=await loadSegmentManifest(project);
  assert.equal(manifest.title,'分镜批注示例 · 三个独立镜头');
  assert.equal(manifest.renderAdapter,'render.mjs');
});
test('demo source and media renderers share exact moving geometry and independent shot content',()=>{
  const first=getScene(.2,1),later=getScene(2,1),second=getScene(4,2),third=getScene(7,3);
  assert.notDeepEqual(first.rectangles,later.rectangles);
  assert.notDeepEqual(second.rectangles,third.rectangles);
  const pixels=rasterizeScene(getScene(0,1));
  assert.equal(pixels.length,1920*1080*3);
  assert.deepEqual([...pixels.subarray(0,3)],[16,24,36]);
  const accentOffset=(100*1920+100)*3;
  assert.deepEqual([...pixels.subarray(accentOffset,accentOffset+3)],[92,200,255]);
});
