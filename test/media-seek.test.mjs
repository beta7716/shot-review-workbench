import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seekVideoFrame } from '../public/media-seek.js';

class FakeVideo extends EventTarget {
  constructor({ time = 0, duration = 10, readyState = 2, onSeek } = {}) {
    super();
    this._time = time;
    this.duration = duration;
    this.readyState = readyState;
    this.seeking = false;
    this.error = null;
    this.assignments = [];
    this.listeners = new Map();
    this.onSeek = onSeek || (() => queueMicrotask(() => this.completeSeek()));
  }
  get currentTime() { return this._time; }
  set currentTime(value) {
    this.assignments.push(value);
    this._time = value;
    this.seeking = true;
    this.onSeek(value);
  }
  addEventListener(type, listener, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  completeSeek(readyState = 2) {
    this.seeking = false;
    this.readyState = readyState;
    this.dispatchEvent(new Event('seeked'));
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

test('seeks to the requested frame and removes its listeners', async () => {
  const video = new FakeVideo();
  assert.equal(await seekVideoFrame(video, 3.5), 3.5);
  assert.deepEqual(video.assignments, [3.5]);
  assert.equal(video.listenerCount(), 0);
});

test('clamps an EOF request below duration so a drawable final frame remains', async () => {
  const video = new FakeVideo({ duration: 4 });
  const time = await seekVideoFrame(video, 99);
  assert.ok(time < 4 && time > 3.99, `unsafe EOF target: ${time}`);
  assert.equal(video.assignments.length, 1);
  assert.equal(video.listenerCount(), 0);
});

test('clamps negative requests to the start', async () => {
  const video = new FakeVideo({ time: 2 });
  assert.equal(await seekVideoFrame(video, -5), 0);
  assert.deepEqual(video.assignments, [0]);
});

test('does not repeat an already drawable seek at the same position', async () => {
  const video = new FakeVideo({ time: 2.5 });
  assert.equal(await seekVideoFrame(video, 2.5005), 2.5);
  assert.deepEqual(video.assignments, []);
  assert.equal(video.listenerCount(), 0);
});

test('waits for metadata before assigning a position', async () => {
  const video = new FakeVideo({ duration: NaN, readyState: 0 });
  const pending = seekVideoFrame(video, 2, { timeoutMs: 100 });
  await Promise.resolve();
  assert.deepEqual(video.assignments, []);
  video.duration = 5;
  video.readyState = 1;
  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(await pending, 2);
  assert.equal(video.listenerCount(), 0);
});

test('does not resolve seeked until the resulting frame has current data', async () => {
  const video = new FakeVideo({ onSeek() {} });
  let resolved = false;
  const pending = seekVideoFrame(video, 2, { timeoutMs: 100 }).then(time => {
    resolved = true;
    return time;
  });
  video.completeSeek(1);
  await Promise.resolve();
  assert.equal(resolved, false);
  video.readyState = 2;
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(await pending, 2);
  assert.equal(video.listenerCount(), 0);
});

test('rejects and removes listeners when seeked never arrives', async () => {
  const video = new FakeVideo({ onSeek() {} });
  await assert.rejects(seekVideoFrame(video, 3, { timeoutMs: 15 }), /timed? out|timeout/i);
  assert.equal(video.listenerCount(), 0);
});

test('rejects missing metadata within the same finite time budget', async () => {
  const video = new FakeVideo({ duration: NaN, readyState: 0 });
  await assert.rejects(seekVideoFrame(video, 3, { timeoutMs: 15 }), /metadata.*timed? out|timeout/i);
  assert.deepEqual(video.assignments, []);
  assert.equal(video.listenerCount(), 0);
});

test('rejects decode errors and clears both listeners and timeout', async t => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set();
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const handle = originalSetTimeout(() => {
      timers.delete(handle);
      callback(...args);
    }, delay);
    timers.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => {
    timers.delete(handle);
    return originalClearTimeout(handle);
  });
  const video = new FakeVideo({ onSeek() {} });
  const pending = seekVideoFrame(video, 3, { timeoutMs: 100 });
  video.error = { code: 3, message: 'decode failed' };
  video.dispatchEvent(new Event('error'));
  await assert.rejects(pending, /decode failed/);
  assert.equal(video.listenerCount(), 0);
  assert.equal(timers.size, 0);
});
