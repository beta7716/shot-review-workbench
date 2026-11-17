import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {initializeSegmentCache,renderSelectedSegments,composeSegments,loadSegmentManifest,videoEncoding,probeMedia} from '../lib/segments.mjs';

const run=promisify(execFile);
const hasMediaTools=['ffmpeg','ffprobe'].every(tool=>spawnSync(tool,['-version'],{windowsHide:true,stdio:'ignore'}).status===0);

test('local adapter rebuilds one shot and composes with unchanged original audio', {skip:!hasMediaTools},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'review-adapter-integration-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const dataRoot=path.join(dir,'data');
  await mkdir(path.join(dir,'out'));
  await writeFile(path.join(dir,'timeline.json'),JSON.stringify([{id:1,start:0,end:.1},{id:2,start:.1,end:.2}]));
  await writeFile(path.join(dir,'review-project.json'),JSON.stringify({title:'Test adapter',renderAdapter:'render.mjs'}));
  await writeFile(path.join(dir,'render.mjs'),`
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export async function renderShot({outputPath,shot,fps,width,height,encodingArgs}) {
  await run('ffmpeg',['-y','-v','error','-f','lavfi','-i',\`color=c=blue:s=\${width}x\${height}:r=\${fps}\`,'-frames:v',String(shot.frameCount),'-an',...encodingArgs,'-video_track_timescale','30000','-movflags','+faststart',outputPath],{windowsHide:true});
}
`);
  await run('ffmpeg',['-y','-v','error','-f','lavfi','-i','color=c=red:s=1920x1080:r=30','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-frames:v','6','-t','0.2',...videoEncoding(),'-c:a','aac','-video_track_timescale','30000','-movflags','+faststart',path.join(dir,'out/master.mp4')],{windowsHide:true});
  const initial=await initializeSegmentCache(dir,{dataRoot});
  assert.equal(initial.availableCount,2);
  const firstHash=initial.shots[0].fileSHA256,secondHash=initial.shots[1].fileSHA256;
  const rendered=await renderSelectedSegments(dir,{dataRoot,shotIds:[2]});
  assert.deepEqual(rendered.renderedShotIds,[2]);
  const after=await loadSegmentManifest(dir,{dataRoot});
  assert.equal(after.shots[0].fileSHA256,firstHash);
  assert.notEqual(after.shots[1].fileSHA256,secondHash);
  assert.equal(after.shots[1].origin,'source-render');
  const composed=await composeSegments(dir,{dataRoot,outputName:'adapter-result'});
  assert.equal(composed.audioCopied,true);
  assert.deepEqual(composed.renderedShotIds,[2]);
  assert.deepEqual(composed.reusedShotIds,[1]);
  assert.equal(composed.totalFrames,6);
  const info=await probeMedia(composed.outputPath);
  assert.equal(info.streams.find(s=>s.codec_type==='video').nb_read_frames,'6');
  assert.equal(info.streams.find(s=>s.codec_type==='audio').codec_name,'aac');
});
