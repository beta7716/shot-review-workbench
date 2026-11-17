const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const film = $('#film');
const hit = $('#hit');
const ctx = hit.getContext('2d');
const state = { duration: 0, time: 0, desiredTime: 0, shots: [], components: [], selected: null, edits: [], playing: false, rendering: false, pendingTime: null, projectReady: false, renderTask: null, raf: null, timer: null, playGeneration: 0, anchorTime: 0, anchorWall: 0, lastFrame: -1, quality: 720, activeShot: null };
const sample = { start: 0, frames: 0, paintMs: 0 };
const shotButtons = new Map();
const FRAME_MS = 1000 / 30;

const fmt = value => {
  const t = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};
const setStatus = text => { $('#status').textContent = text; };

function resizeHit() {
  const rect = hit.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (hit.width !== width) hit.width = width;
  if (hit.height !== height) hit.height = height;
  drawHitRegions();
}

function drawHitRegions() {
  ctx.clearRect(0, 0, hit.width, hit.height);
  for (const component of state.components) {
    if (!isSelectable(component)) continue;
    if (state.playing && !selectedMatches(component)) continue;
    const x = component.x / 1920 * hit.width;
    const y = component.y / 1080 * hit.height;
    const w = component.w / 1920 * hit.width;
    const h = component.h / 1080 * hit.height;
    const selected = selectedMatches(component);
    ctx.strokeStyle = selected ? '#22d3ee' : '#f59e0b';
    ctx.lineWidth = selected ? 3 : 1;
    ctx.setLineDash(selected ? [] : [6, 4]);
    ctx.strokeRect(x, y, w, h);
  }
  ctx.setLineDash([]);
}

function isSelectable(component) {
  const area = (component.w || 0) * (component.h || 0);
  return area >= 800 && area < 1500000;
}

function selectedMatches(component) {
  const selected = state.selected;
  if (!selected || selected.shotId !== component.shotId || selected.kind !== component.kind) return false;
  if (selected.tag && selected.tag !== component.tag) return false;
  if (selected.text && selected.text !== component.text) return false;
  if (selected.color && selected.color !== component.color) return false;
  const distance = Math.abs(selected.x - component.x) + Math.abs(selected.y - component.y) + Math.abs(selected.w - component.w) + Math.abs(selected.h - component.h);
  return selected.id === component.id || distance < Math.max(80, selected.w + selected.h);
}

function renderShots() {
  const box = $('#shots');
  box.innerHTML = '';
  shotButtons.clear();
  for (const shot of state.shots) {
    const element = document.createElement('button');
    element.className = 'shot';
    element.type = 'button';
    element.innerHTML = `<b>T${escapeHTML(String(shot.id).padStart(2, '0'))} · ${escapeHTML(shot.kind)}</b><small>${fmt(shot.start)} – ${fmt(shot.end)}<br>${escapeHTML(shot.title || shot.anchor || shot.focus || '')}</small>`;
    element.addEventListener('click', () => { state.selected = null; showDetail(); seekTo(Number(shot.start) || 0); });
    box.appendChild(element);
    shotButtons.set(shot.id, element);
  }
}

function showDetail() {
  const component = state.selected;
  if (!component) {
    $('#empty').hidden = false;
    $('#detail').hidden = true;
    return;
  }
  $('#empty').hidden = true;
  $('#detail').hidden = false;
  $('#cid').textContent = component.id;
  const label = [component.kind, component.tag || component.text || ''].filter(Boolean).join(' · ');
  $('#ctype').textContent = `${label} · ${Math.round(component.x)},${Math.round(component.y)} · ${Math.round(component.w)}×${Math.round(component.h)}`;
  $('#replaceHint').textContent = `当前镜头 ${fmt(component.shotStart)}–${fmt(component.shotEnd)}，替换会跟随这个组件的位置和时间段。`;
}

function signature(component) {
  return { kind: component.kind, tag: component.tag || null, text: component.text || null, color: component.color || null };
}
function postEdits() {
  const project = film.contentWindow;
  if (typeof project?.setEditorEdits === 'function') project.setEditorEdits(state.edits);
  else project?.postMessage({ type: 'EDITOR_EDITS', edits: state.edits, redraw: false }, location.origin);
}

async function loadSavedEdits() {
  try {
    const response = await fetch('/project/editor-edits.json', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (!state.edits.length && Array.isArray(data?.edits) && data.edits.length) {
      state.edits = data.edits;
      postEdits();
      renderAt(state.time);
      setStatus(`已载入 ${state.edits.length} 个上次保存的源工程替换项`);
    }
  } catch {}
}

function initProject() {
  if (state.projectReady) return true;
  const project = film.contentWindow;
  if (!project || typeof project.render !== 'function') return false;
  const firstLoad = !state.projectReady;
  state.projectReady = true;
  state.duration = Number(project.DUR) || state.duration;
  state.shots = Array.isArray(project.SHOTS) ? project.SHOTS : state.shots;
  $('#time').max = state.duration;
  renderShots();
  resizeHit();
  postEdits();
  if (firstLoad) setStatus(`源工程已加载 · ${state.shots.length} 个镜头 · 点击画面中的组件开始编辑`);
  return true;
}

function renderAt(time) {
  if (!state.projectReady && !initProject()) return;
  state.desiredTime = Math.max(0, Math.min(state.duration || 0, Number(time) || 0));
  state.pendingTime = state.desiredTime;
  if (state.rendering) return state.renderTask;
  state.rendering = true;
  state.renderTask = (async () => {
    while (state.pendingTime != null) {
      const next = state.pendingTime;
      state.pendingTime = null;
      const began = performance.now();
      try { await film.contentWindow.render(next, { playing: state.playing, previewHeight: state.quality }); }
      catch (error) { stopPlayback(false); setStatus(`预览失败：${error.message || error}`); break; }
      sample.frames++;
      sample.paintMs += performance.now() - began;
      const elapsed = performance.now() - sample.start;
      if (state.playing && elapsed >= 750) {
        $('#perf').textContent = `${(sample.frames * 1000 / elapsed).toFixed(1)} fps · 平均绘制 ${(sample.paintMs / sample.frames).toFixed(0)} ms`;
        sample.start = performance.now(); sample.frames = 0; sample.paintMs = 0;
      }
    }
    state.rendering = false;
  })();
  return state.renderTask;
}

function playbackTime(now = performance.now()) {
  return Math.min(state.duration, state.anchorTime + (now - state.anchorWall) / 1000);
}

function stopPlayback(renderFinal = true) {
  const wasPlaying = state.playing;
  const time = wasPlaying ? playbackTime() : state.desiredTime;
  state.playing = false;
  state.playGeneration++;
  if (state.raf != null) cancelAnimationFrame(state.raf);
  if (state.timer != null) clearTimeout(state.timer);
  state.raf = state.timer = null;
  $('#play').textContent = '播放';
  film.contentWindow?.pauseEditorMedia?.();
  $('#perf').textContent = '已暂停 · 点击组件可编辑';
  if (renderFinal && wasPlaying) return renderAt(time);
  drawHitRegions();
}

function seekTo(time) {
  stopPlayback(false);
  return renderAt(time);
}

function playTick(now) {
  if (!state.playing) return;
  const time = playbackTime(now);
  const frame = Math.floor((now - state.anchorWall) / FRAME_MS);
  if (frame !== state.lastFrame) {
    state.lastFrame = frame;
    renderAt(time);
  }
  if (time >= state.duration) { stopPlayback(false); renderAt(state.duration); return; }
  schedulePlayTick();
}

function schedulePlayTick() {
  const generation = state.playGeneration;
  let fired = false;
  const tick = now => {
    if (fired || generation !== state.playGeneration) return;
    fired = true;
    if (state.raf != null) cancelAnimationFrame(state.raf);
    if (state.timer != null) clearTimeout(state.timer);
    state.raf = state.timer = null;
    playTick(now);
  };
  state.raf = requestAnimationFrame(tick);
  state.timer = setTimeout(() => tick(performance.now()), FRAME_MS);
}

function saveEdits() {
  const blob = new Blob([JSON.stringify({ version: 2, project: film.contentWindow?.document?.title || 'source-project', edits: state.edits }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'edits.json';
  link.click();
  URL.revokeObjectURL(url);
  setStatus(`已保存 ${state.edits.length} 个源工程替换项`);
}

film.addEventListener('load', () => {
  stopPlayback(false);
  state.projectReady = false;
  setStatus('正在等待源工程完成加载…');
  initProject();
  loadSavedEdits();
});

window.addEventListener('message', event => {
  if (event.source !== film.contentWindow || event.origin !== location.origin || event.data?.type !== 'frame') return;
  if (!state.projectReady) initProject();
  state.time = Number(event.data.time) || 0;
  state.components = Array.isArray(event.data.components) ? event.data.components : [];
  if (!state.shots.length && Array.isArray(film.contentWindow?.SHOTS)) {
    state.shots = film.contentWindow.SHOTS;
    renderShots();
  }
  $('#time').value = state.time;
  $('#clock').textContent = fmt(state.time);
  const shotId = event.data.shot?.id;
  if (shotId !== state.activeShot) {
    shotButtons.get(state.activeShot)?.classList.remove('active');
    shotButtons.get(shotId)?.classList.add('active');
    state.activeShot = shotId;
  }
  drawHitRegions();
});

hit.addEventListener('click', async event => {
  if (state.playing) {
    const displayedTime = state.time;
    stopPlayback(false);
    await renderAt(displayedTime);
    const components = film.contentWindow?.COMPONENTS?.();
    if (Array.isArray(components)) state.components = components;
  }
  const rect = hit.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const candidates = state.components
    .filter(isSelectable)
    .filter(component => {
      const left = component.x / 1920 * rect.width;
      const top = component.y / 1080 * rect.height;
      const right = (component.x + component.w) / 1920 * rect.width;
      const bottom = (component.y + component.h) / 1080 * rect.height;
      return x >= left && x <= right && y >= top && y <= bottom;
    })
    .sort((a, b) => (a.w * a.h) - (b.w * b.h));
  state.selected = candidates[0] || null;
  showDetail();
  drawHitRegions();
  if (state.selected) setStatus(`已选中 ${state.selected.kind} 组件 · 可替换素材并实时预览`);
});

$('#time').addEventListener('input', event => seekTo(event.target.value));

$('#play').addEventListener('click', () => {
  if (state.playing) { stopPlayback(); return; }
  if (!initProject()) return;
  state.playing = true;
  state.anchorTime = state.desiredTime >= state.duration ? 0 : state.desiredTime;
  state.anchorWall = performance.now();
  state.lastFrame = -1;
  sample.start = state.anchorWall; sample.frames = 0; sample.paintMs = 0;
  $('#play').textContent = '暂停';
  $('#perf').textContent = '播放中 · 目标 30 fps';
  drawHitRegions();
  renderAt(state.anchorTime);
  schedulePlayTick();
});

$('#quality').addEventListener('change', event => {
  state.quality = [540, 720, 1080].includes(Number(event.target.value)) ? Number(event.target.value) : 720;
  renderAt(state.playing ? playbackTime() : state.desiredTime);
});

document.addEventListener('visibilitychange', () => { if (document.hidden && state.playing) stopPlayback(); });

$('#add').addEventListener('click', async () => {
  if (!state.selected) return setStatus('请先点击画面中的组件');
  const file = $('#asset').files[0];
  if (!file) return setStatus('请选择替换图片或视频');
  try {
    setStatus('正在导入替换素材…');
    const response = await fetch(`/api/upload?kind=replacement&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
    const uploaded = await response.json();
    if (!response.ok || !uploaded.ok) throw new Error(uploaded.error || '上传失败');
    const component = state.selected;
    const edit = {
      componentId: component.id,
      componentSignature: signature(component),
      originalBounds: { x: component.x, y: component.y, w: component.w, h: component.h },
      shotId: component.shotId,
      start: component.shotStart ?? component.time ?? state.time,
      end: component.shotEnd ?? ((component.time ?? state.time) + 1),
      assetPath: uploaded.path,
      assetUrl: uploaded.url,
      assetName: file.name,
      fit: $('#fit').value
    };
    state.edits = state.edits.filter(item => item.componentId !== edit.componentId);
    state.edits.push(edit);
    postEdits();
    renderAt(state.time);
    setStatus(`已替换 ${component.kind}，预览正在更新`);
  } catch (error) {
    setStatus(`替换失败：${error.message || error}`);
  }
});

$('#save').addEventListener('click', saveEdits);

$('#renderSource').addEventListener('click', async () => {
  if (!state.edits.length) return setStatus('请先添加至少一个组件替换');
  try {
    setStatus('正在按源工程渲染 MP4，请稍候…');
    const response = await fetch('/api/source-render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ edits: state.edits, outputName: `source-edited-${Date.now()}.mp4` }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '源工程渲染失败');
    const link = $('#renderDownload');
    link.href = result.url;
    link.hidden = false;
    setStatus('源工程 MP4 已生成，可下载检查');
  } catch (error) {
    setStatus(`源工程渲染失败：${error.message || error}`);
  }
});

window.addEventListener('resize', resizeHit);
