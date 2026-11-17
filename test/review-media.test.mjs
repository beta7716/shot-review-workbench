import test from 'node:test';
import assert from 'node:assert/strict';
import { SegmentAudioSync } from '../public/review-media.mjs';

class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.src = ''; this.paused = true; this.ended = false; this.seeking = false;
    this.readyState = 4; this.duration = 20; this.playbackRate = 1; this.volume = .7; this.muted = false;
    this.position = 0; this.seeks = []; this.playCalls = 0; this.pauseCalls = 0; this.loadCalls = 0;
  }
  get currentTime() { return this.position; }
  set currentTime(value) { this.position = value; this.seeks.push(value); }
  pause() { this.pauseCalls++; this.paused = true; }
  play() { this.playCalls++; return this.onPlay ? this.onPlay() : (this.paused = false, Promise.resolve()); }
  load() { this.loadCalls++; }
  fire(name) { this.dispatchEvent(new Event(name)); }
}

function fixture() {
  const video = new FakeMedia(), audio = new FakeMedia(), errors = [];
  let context = { usingClip: true, offset: 80 / 30, duration: 20, url: '/full.mp4', baseUrl: 'http://localhost/review.html', loading: false };
  const sync = new SegmentAudioSync(video, audio, () => context, message => errors.push(message));
  return { video, audio, errors, sync, context, setContext: value => { context = { ...context, ...value }; } };
}
const settle = async sync => { if (sync.pendingPlay) await sync.pendingPlay; };

test('silent segments use the full-film soundtrack at the exact frame origin', async () => {
  const { video, audio, sync } = fixture();
  video.currentTime = .5; video.playbackRate = 1.25;
  sync.sync({ force: true });
  assert.equal(audio.src, 'http://localhost/full.mp4');
  assert.equal(audio.currentTime, 80 / 30 + .5);
  assert.equal(audio.playbackRate, 1.25);
  assert.equal(audio.volume, .7);
  assert.equal(video.muted, true);
  assert.equal(audio.playCalls, 0);
  video.paused = false; video.fire('playing');
  assert.equal(audio.playCalls, 1, 'play is called synchronously within a user activation');
  await settle(sync);
  assert.equal(audio.paused, false);
  video.paused = true; video.fire('pause');
  assert.equal(audio.paused, true);
  sync.destroy();
});

test('seeking, loading and buffering pause sound and resume in sync', async () => {
  const { video, audio, sync, setContext } = fixture();
  video.paused = false; video.fire('playing'); await settle(sync);
  video.seeking = true; video.currentTime = 4; video.fire('seeking');
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 4 + 80 / 30);
  video.seeking = false; video.fire('seeked'); await settle(sync);
  assert.equal(audio.paused, false);
  video.fire('waiting'); assert.equal(audio.paused, true);
  video.fire('timeupdate'); assert.equal(audio.paused, true);
  video.fire('playing'); await settle(sync); assert.equal(audio.paused, false);
  setContext({ loading: true }); sync.sync(); assert.equal(audio.paused, true);
  sync.destroy();
});

test('switching to the full film stops the separate audio and restores no duplicate playback', async () => {
  const { video, audio, sync, setContext } = fixture();
  video.paused = false; sync.sync(); await settle(sync);
  setContext({ usingClip: false }); sync.sync();
  assert.equal(audio.paused, true);
  const calls = audio.playCalls; video.fire('playing'); await settle(sync);
  assert.equal(audio.playCalls, calls);
  sync.destroy();
});

test('time updates correct audible drift without repeated seeks at a settled position', () => {
  const { video, audio, sync } = fixture();
  sync.sync({ force: true });
  const initialSeeks = audio.seeks.length;
  audio.fire('canplay'); audio.fire('canplay');
  assert.equal(audio.seeks.length, initialSeeks);
  audio.position += .1; video.fire('timeupdate');
  assert.equal(audio.seeks.length, initialSeeks, 'small drift avoids unnecessary decoding seeks');
  audio.position += .2; video.fire('timeupdate');
  assert.equal(audio.seeks.length, initialSeeks + 1);
  assert.equal(audio.currentTime, 80 / 30);
  video.playbackRate = 1.5; video.fire('ratechange');
  assert.equal(audio.playbackRate, 1.5);
  sync.destroy();
});

test('a pending play cannot leave audio running after pause or switching mode', async () => {
  for (const next of ['pause', 'full']) {
    const { video, audio, sync, errors, setContext } = fixture();
    let finish;
    audio.onPlay = () => new Promise(resolve => { finish = () => { audio.paused = false; resolve(); }; });
    video.paused = false; sync.sync(); sync.sync();
    assert.equal(audio.playCalls, 1);
    if (next === 'pause') { video.paused = true; video.fire('pause'); }
    else { setContext({ usingClip: false }); sync.sync(); }
    finish(); await settle(sync);
    assert.equal(audio.paused, true);
    assert.equal(sync.pendingPlay, null);
    assert.equal(errors.length, 0);
    sync.destroy();
  }
});

test('normal source-change AbortError does not block the following segment', async () => {
  const { video, audio, sync, errors } = fixture();
  audio.onPlay = () => Promise.reject(new DOMException('A pause interrupted playback', 'AbortError'));
  video.paused = false; sync.sync(); await settle(sync);
  assert.equal(sync.blocked, false); assert.equal(errors.length, 0);
  audio.onPlay = null; video.fire('playing'); await settle(sync);
  assert.equal(audio.playCalls, 2); assert.equal(audio.paused, false);
  sync.destroy();
});

test('autoplay rejection is handled once and an explicit play gesture retries', async () => {
  const { video, audio, sync, errors } = fixture();
  audio.onPlay = () => Promise.reject(new DOMException('Requires user activation', 'NotAllowedError'));
  video.paused = false; sync.sync(); await settle(sync);
  assert.equal(sync.blocked, true); assert.equal(errors.length, 1);
  video.fire('timeupdate'); await settle(sync); assert.equal(audio.playCalls, 1);
  audio.onPlay = null; sync.sync({ force: true, fromGesture: true }); await settle(sync);
  assert.equal(sync.blocked, false); assert.equal(audio.playCalls, 2); assert.equal(audio.paused, false);
  sync.destroy();
});

test('destroy removes listeners and late rejections do not produce an error', async () => {
  const { video, audio, sync, errors } = fixture();
  let reject;
  audio.onPlay = () => new Promise((resolve, fail) => { reject = fail; });
  video.paused = false; sync.sync();
  sync.destroy(); reject(new DOMException('No longer allowed', 'NotAllowedError')); await settle(sync);
  video.fire('playing'); assert.equal(audio.playCalls, 1);
  assert.equal(errors.length, 0); assert.equal(audio.paused, true);
});
