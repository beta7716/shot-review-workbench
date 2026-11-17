import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/source-editor.js', import.meta.url), 'utf8');

function createEditor({ slowRender = false } = {}) {
  let now = 0, sequence = 0;
  const rafs = new Map(), timers = new Map(), messages = [], renders = [], waiters = [];
  const windowListeners = new Map();
  const context2d = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) });
  class Element {
    constructor(id = '') { this.id = id; this.children = []; this.listeners = new Map(); this.value = ''; this.textContent = ''; this.hidden = false; this.width = 900; this.height = 506; this.files = []; this.dataset = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
    getContext() { return context2d; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 506 }; }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    setAttribute() {}
    querySelector() { return null; }
    scrollIntoView() {}
    set innerHTML(value) { this._html = value; if (!value) this.children = []; }
    get innerHTML() { return this._html || ''; }
    click() { return this.listeners.get('click')?.({}); }
  }
  const ids = ['film','hit','shots','status','time','clock','play','quality','perf','empty','detail','cid','ctype','replaceHint','asset','fit','add','save','renderSource','renderDownload'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  elements.quality.value = '720';
  let active = 0, maxConcurrent = 0;
  const project = {
    DUR: 100, SHOTS: [{ id: 1, start: 0, end: 50, kind: 'test' }, { id: 2, start: 50, end: 100, kind: 'test' }],
    postMessage(message) { messages.push(message); },
    async render(time) {
      renders.push(time); active++; maxConcurrent = Math.max(maxConcurrent, active);
      if (slowRender) await new Promise(resolve => waiters.push(resolve));
      active--;
      windowListeners.get('message')?.({ source: project, origin: 'http://localhost', data: { type: 'frame', time, components: [], shot: { id: 1 } } });
    },
    pauseEditorMedia() {},
  };
  elements.film.contentWindow = project;
  const sandbox = {
    document: { querySelector: selector => elements[selector.slice(1)], createElement: () => new Element(), hidden: false, addEventListener() {} },
    window: { addEventListener: (type, fn) => windowListeners.set(type, fn), location: { origin: 'http://localhost' } },
    location: { origin: 'http://localhost' },
    performance: { now: () => now },
    requestAnimationFrame: fn => { const id = ++sequence; rafs.set(id, fn); return id; },
    cancelAnimationFrame: id => rafs.delete(id),
    fetch: async () => ({ ok: true, json: async () => ({ edits: [] }) }),
    localStorage: { getItem: () => null, setItem() {} },
    Blob, URL, console,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(source, sandbox, { filename: 'source-editor.js' });
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    elements, project, messages, renders, waiters, settle,
    async load() { elements.film.listeners.get('load')(); await settle(); },
    async frame(time) { windowListeners.get('message')({ source: project, origin: 'http://localhost', data: { type: 'frame', time, components: [], shot: { id: 1 } } }); await settle(); },
    async advance(ms, { deliverRaf = true } = {}) { now += ms; const queued = deliverRaf ? [...rafs.entries()] : []; const due = [...timers.entries()].filter(([, timer]) => timer.due <= now); for (const [id, fn] of queued) { if (rafs.delete(id)) fn(now); } for (const [id, timer] of due) { if (timers.delete(id)) timer.fn(); } await settle(); },
    async seek(time) { elements.time.value = String(time); elements.time.listeners.get('input')({ target: elements.time }); await settle(); },
    concurrent: () => maxConcurrent,
  };
}

test('completed frames do not send edits back or rebuild the mirror list', async () => {
  const editor = createEditor(); await editor.load();
  const sends = editor.messages.length;
  const firstButton = editor.elements.shots.children[0];
  await editor.frame(1); await editor.frame(2);
  assert.equal(editor.messages.length, sends, 'frame acknowledgements must not trigger another render');
  assert.equal(editor.elements.shots.children[0], firstButton, 'mirror buttons must stay mounted between frames');
});

test('slow paints cannot rewind the playback clock', async () => {
  const editor = createEditor({ slowRender: true }); await editor.load();
  editor.elements.play.click();
  await editor.advance(1000);
  await editor.advance(1000);
  assert.equal(editor.renders.length, 1, 'only one frame may render at a time');
  editor.waiters.shift()(); await editor.settle();
  await editor.advance(1000);
  editor.waiters.shift()(); await editor.settle();
  assert.ok(editor.renders.at(-1) >= 2.95, `three seconds elapsed; requested ${editor.renders.at(-1)}`);
  assert.equal(editor.concurrent(), 1);
});

test('scrubbing keeps only the newest pending target', async () => {
  const editor = createEditor({ slowRender: true }); await editor.load();
  await editor.seek(10); await editor.seek(20); await editor.seek(30);
  assert.deepEqual(editor.renders, [10]);
  editor.waiters.shift()(); await editor.settle();
  assert.deepEqual(editor.renders, [10, 30]);
  editor.waiters.shift()(); await editor.settle();
  assert.equal(editor.elements.time.value, 30);
  assert.equal(editor.concurrent(), 1);
});

test('rapid pause and resume cannot create multiple animation loops', async () => {
  const editor = createEditor(); await editor.load();
  editor.elements.play.click(); editor.elements.play.click(); editor.elements.play.click();
  await editor.advance(1000);
  const first = editor.renders.length;
  await editor.advance(34);
  assert.ok(editor.renders.length <= first + 1, 'one scheduled tick must produce at most one paint');
});

test('small animation-frame jitter does not reduce a 30 fps preview to 20 fps', async () => {
  const editor = createEditor(); await editor.load();
  editor.elements.play.click();
  for (let i = 0; i < 60; i++) await editor.advance(16.4);
  assert.ok(editor.renders.length >= 28, `984 ms should paint about 30 frames, received ${editor.renders.length}`);
  assert.ok(editor.renders.length <= 31);
});

test('a delayed browser frame callback cannot stall a visible preview', async () => {
  const editor = createEditor(); await editor.load();
  editor.elements.play.click();
  await editor.settle();
  const initialRenders = editor.renders.length;
  await editor.advance(34, { deliverRaf: false });
  assert.equal(editor.renders.length, initialRenders + 1, 'the fallback clock must paint without an animation-frame callback');
  assert.ok(editor.renders.at(-1) >= .03);
  editor.elements.play.click();
  await editor.settle();
  const pausedRenders = editor.renders.length;
  await editor.advance(1000, { deliverRaf: false });
  assert.equal(editor.renders.length, pausedRenders, 'pause must cancel the fallback clock');
});
