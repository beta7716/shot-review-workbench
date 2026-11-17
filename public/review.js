import { clamp, timecode, parseTimecode, shotAt, clipStart, clipEnd, shotSeekTime, normalizeRegion, validateNote, orderedNotes, exportReview, previewStatus } from './review-model.mjs';
import { SegmentAudioSync } from './review-media.mjs';

const $ = selector => document.querySelector(selector);
const player = $('#player');
const state = { project: null, document: null, shotId: null, mode: 'full', shotFilter: 'all', draft: null, marking: false, drag: null, sourceStart: 0, sourceEnd: 0, sourceOffset: 0, usingClip: false, seekOnLoad: null, loadingGeneration: 0, saveRevision: 0, savedRevision: 0, saveTask: null, conflict: false, toastTimer: null, job: null, uploading: false, ready: false };
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
const storageKey = () => `review-workbench:${state.project.id}`;
const selectedShot = () => state.project?.shots.find(shot => shot.id === state.shotId);
const draftShot = () => state.project?.shots.find(shot => shot.id === state.draft?.shotId);
const globalTime = () => clamp((Number(player.currentTime) || 0) + state.sourceOffset, 0, state.project?.duration || 0);
const hasDraftContent = () => Boolean(state.uploading || state.draft?.id || $('#note-text').value.trim() || state.draft?.attachments?.length || state.draft?.region);
const audioSync = new SegmentAudioSync(player, $('#segment-audio'), () => ({ usingClip: state.usingClip, offset: state.sourceOffset, duration: state.project?.duration, url: state.project?.fullVideoUrl, baseUrl: location.href, loading: Boolean(state.seekOnLoad) }), message => { $('#preview-status').textContent = message; toast(message); });

function hasUnsavedDraft() {
  if (!hasDraftContent()) return false;
  const current = readDraft();
  const original = state.document?.notes.find(note => note.id === current.id);
  if (!original) return true;
  if (!Number.isFinite(parseTimecode(current.timeInput)) || !Number.isFinite(parseTimecode(current.endInput))) return true;
  return current.scope !== original.scope || current.shotId !== original.shotId || current.text.trim() !== original.text || Math.abs(parseTimecode(current.timeInput) - original.time) > .00051 || Math.abs(parseTimecode(current.endInput) - original.endTime) > .00051 || JSON.stringify(current.region) !== JSON.stringify(original.region) || JSON.stringify(current.attachments) !== JSON.stringify(original.attachments);
}

function toast(message) {
  clearTimeout(state.toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function saveLabel(text, failed = false) {
  $('#save-state').textContent = text;
  $('#save-state').classList.toggle('error', failed);
}

function storeLocal(dirty = state.saveRevision > state.savedRevision) {
  if (!state.project) return;
  try { localStorage.setItem(storageKey(), JSON.stringify({ document: state.document, draft: readDraft(), dirty, savedAt: new Date().toISOString() })); }
  catch { saveLabel('本地备份不可用，请导出批注', true); }
}

function readDraft() {
  if (!state.draft) return null;
  return { ...state.draft, scope: $('#scope').value, text: $('#note-text').value, timeInput: $('#note-start').value, endInput: $('#note-end').value };
}

function changed() {
  state.document.updatedAt = new Date().toISOString();
  state.saveRevision++;
  storeLocal(true);
  renderCounts(); renderShots(); renderNotes();
  void persist();
}

async function persist() {
  if (state.conflict) return;
  if (state.saveTask) return state.saveTask;
  state.saveTask = (async () => {
    while (state.savedRevision < state.saveRevision) {
      const revision = state.saveRevision;
      const payload = JSON.parse(JSON.stringify(state.document));
      saveLabel('正在保存…');
      try {
        const data = await api('/api/review/notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        state.savedRevision = revision;
        if (data.document) {
          if (revision === state.saveRevision) state.document = data.document;
          else state.document.revision = data.document.revision;
        }
        storeLocal(state.savedRevision < state.saveRevision);
        saveLabel('全部批注已保存');
        renderNotes();
      } catch (error) {
        storeLocal(true);
        if (error.status === 409) { state.conflict = true; saveLabel('版本冲突 · 请复制或导出本地批注', true); toast('另一页面已更新批注。本页停止覆盖，内容保留在本地，请先复制或导出。'); }
        else { saveLabel('服务器未保存 · 已留本地备份', true); toast(`保存失败：${error.message}。批注仍在本地，可复制或导出。`); }
        break;
      }
    }
  })().finally(() => { state.saveTask = null; });
  return state.saveTask;
}

async function api(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回无效数据（${response.status}）`); }
  if (!response.ok || data.ok === false) { const error = new Error(data.error || `请求失败（${response.status}）`); error.status = response.status; throw error; }
  return data;
}

function renderCounts() {
  const notes = state.document.notes;
  $('#shot-count').textContent = `${state.project.shots.length} 段`;
  $('#copy-count').textContent = String(notes.length);
  $('#note-total').textContent = String(notes.length);
  $('#annotated-count').textContent = String(new Set(notes.filter(note => note.scope === 'shot').map(note => note.shotId)).size);
}

function renderShots() {
  if (!state.project) return;
  const query = $('#shot-search').value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  for (const shot of state.project.shots) {
    const count = state.document.notes.filter(note => note.scope === 'shot' && note.shotId === shot.id).length;
    if (query && !`${shot.id} ${shot.title} ${shot.kind}`.toLowerCase().includes(query)) continue;
    if (state.shotFilter === 'notes' && !count) continue;
    const row = element('button', `shot-row${shot.id === state.shotId ? ' active' : ''}`);
    row.type = 'button'; row.dataset.shotId = shot.id;
    row.setAttribute('aria-label', `镜头 ${shot.id} ${shot.title}，${count} 条批注`);
    row.setAttribute('aria-current', shot.id === state.shotId ? 'true' : 'false');
    row.append(element('span', 'shot-number', String(shot.id).padStart(2, '0')));
    const copy = element('span', 'shot-copy');
    copy.append(element('b', '', shot.title || `片段 ${shot.id}`), element('small', '', `${timecode(shot.start)} – ${timecode(shot.end)}`));
    row.append(copy);
    if (count) row.append(element('span', 'shot-badge', String(count)));
    row.addEventListener('click', () => selectShot(shot.id));
    fragment.append(row);
  }
  if (!fragment.childNodes.length) fragment.append(element('p', 'empty-notes', '没有匹配的片段'));
  $('#shots').replaceChildren(fragment);
}

function refreshShotActive() {
  for (const row of $('#shots').querySelectorAll('[data-shot-id]')) {
    const active = Number(row.dataset.shotId) === state.shotId;
    row.classList.toggle('active', active); row.setAttribute('aria-current', String(active));
  }
}

function setMode(mode) {
  const time = globalTime();
  const wasPlaying = !player.paused;
  state.mode = mode;
  $('#mode-shot').classList.toggle('active', mode === 'shot');
  $('#mode-full').classList.toggle('active', mode === 'full');
  loadPlayback(time, wasPlaying);
}

function selectShot(id, time = null, autoplay = false) {
  const shot = state.project.shots.find(item => item.id === id);
  if (!shot) return;
  const seekTime = shotSeekTime(shot, time ?? clipStart(shot, state.project.fps), state.project.fps);
  state.shotId = id;
  refreshShotActive(); updateTitle(); renderNotes();
  if (!hasDraftContent()) resetDraft(seekTime);
  loadPlayback(seekTime, autoplay);
  drawRegion();
}

function updateTitle() {
  const shot = selectedShot();
  $('#shot-label').textContent = shot ? `镜头 ${String(shot.id).padStart(2, '0')} / ${state.project.shots.length} · ${timecode(shot.start)} – ${timecode(shot.end)}` : '整片预览';
  $('#shot-title').textContent = shot?.title || state.project.title;
  $('#previous').disabled = !shot || state.project.shots.indexOf(shot) === 0;
  $('#next').disabled = !shot || state.project.shots.indexOf(shot) === state.project.shots.length - 1;
}

function showPlaceholder(heading, detail = '') {
  $('#player-placeholder').hidden = false;
  $('#player-placeholder b').textContent = heading;
  $('#player-placeholder p').textContent = detail;
}

function loadPlayback(time = 0, autoplay = false) {
  const shot = selectedShot();
  if (!shot) return;
  const clip = state.mode === 'shot' && Boolean(shot.available && shot.url);
  const url = clip ? shot.url : state.project.fullVideoUrl;
  state.usingClip = clip;
  audioSync.stop();
  player.pause();
  player.muted = clip;
  state.sourceStart = state.mode === 'full' ? 0 : clipStart(shot, state.project.fps);
  state.sourceEnd = state.mode === 'full' ? state.project.duration : clipEnd(shot, state.project.fps);
  state.sourceOffset = clip ? clipStart(shot, state.project.fps) : 0;
  $('#seek').min = String(state.sourceStart);
  $('#seek').max = String(state.sourceEnd);
  $('#duration').textContent = timecode(state.sourceEnd);
  $('#preview-status').textContent = previewStatus(state.project, clip, state.mode);
  $('#play').disabled = !url;
  if (!url) { player.pause(); player.removeAttribute('src'); player.load(); showPlaceholder('还没有可播放的视频', '点击左下“准备片段预览”，或让助手生成该工程的片段。'); return; }
  state.seekOnLoad = { time: state.mode === 'full' ? clamp(time, state.sourceStart, state.sourceEnd) : shotSeekTime(shot, time, state.project.fps), autoplay, generation: ++state.loadingGeneration };
  const absoluteURL = new URL(url, location.href).href;
  if (player.src === absoluteURL && player.readyState >= 1) applyPendingSeek();
  else { player.pause(); showPlaceholder('正在载入画面', clip ? '读取当前片段缓存' : '读取全片对应位置'); player.src = url; player.load(); }
}

function applyPendingSeek() {
  const pending = state.seekOnLoad;
  if (!pending) return;
  state.seekOnLoad = null;
  const duration = Number.isFinite(player.duration) ? player.duration : Infinity;
  player.currentTime = clamp(pending.time - state.sourceOffset, 0, Math.max(0, duration - .001));
  player.playbackRate = Number($('#speed').value);
  $('#clock').textContent = timecode(pending.time);
  $('#seek').value = String(pending.time);
  audioSync.sync({ force: true });
  if (pending.autoplay) void player.play().catch(error => toast(`未能自动播放：${error.message}`));
}

function moveShot(delta, autoplay = false) {
  const index = state.project.shots.findIndex(shot => shot.id === state.shotId);
  const next = state.project.shots[index + delta];
  if (next) selectShot(next.id, next.start, autoplay);
  else player.pause();
}

function resetDraft(time = globalTime()) {
  const shot = selectedShot();
  const start = shot ? shotSeekTime(shot, time, state.project.fps) : clamp(time, 0, state.project.duration);
  state.draft = { id: null, scope: 'shot', shotId: shot?.id ?? null, time: start, endTime: start, text: '', region: null, attachments: [] };
  $('#scope').value = 'shot'; $('#note-start').value = timecode(start); $('#note-end').value = timecode(start); $('#note-text').value = '';
  $('#attachments').value = ''; $('#form-error').hidden = true; $('#composer-title').textContent = '添加批注'; $('#cancel-edit').hidden = true; $('#save-note').textContent = '保存批注';
  setMarking(false); renderDraft(); storeLocal();
}

function renderDraft() {
  const shot = draftShot();
  const global = $('#scope').value === 'global';
  $('#target-title').textContent = global ? '全片整体修改' : shot ? `镜头 ${String(shot.id).padStart(2, '0')} · ${shot.title}` : '尚未选择镜头';
  $('#target-range').textContent = `${timecode(global ? 0 : shot?.start || 0)} – ${timecode(global ? state.project.duration : shot?.end || 0)}`;
  const r = state.draft?.region;
  $('#region-label').textContent = r ? r.w < .005 && r.h < .005 ? `已标记位置 · ${Math.round(r.x * 100)}%, ${Math.round(r.y * 100)}%` : `已框选 · ${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%` : '整个画面';
  $('#clear-region').disabled = !r;
  const files = document.createDocumentFragment();
  for (const [index, file] of (state.draft.attachments || []).entries()) {
    const row = element('div', 'attachment-item');
    const link = element('a', '', file.name); link.href = file.url || `/files/${file.path}`; link.target = '_blank'; link.rel = 'noopener';
    const remove = element('button', '', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除附件 ${file.name}`); remove.addEventListener('click', () => { state.draft.attachments.splice(index, 1); renderDraft(); storeLocal(); });
    row.append(link, remove); files.append(row);
  }
  $('#draft-attachments').replaceChildren(files); drawRegion();
}

function drawRegion() {
  const r = state.draft?.region;
  const visible = r && ($('#scope').value === 'global' || state.draft.shotId === state.shotId);
  const box = $('#region'); box.hidden = !visible;
  if (!visible) return;
  box.style.left = `${r.x * 100}%`; box.style.top = `${r.y * 100}%`; box.style.width = `${r.w * 100}%`; box.style.height = `${r.h * 100}%`;
  box.classList.toggle('point', r.w < .005 && r.h < .005);
}

function setMarking(enabled) {
  state.marking = enabled;
  $('#marker-layer').classList.toggle('marking', enabled); $('#mark').classList.toggle('active', enabled); $('#mark').setAttribute('aria-pressed', String(enabled)); $('#mark-tip').hidden = !enabled;
  if (enabled) player.pause();
}

function draftAtCurrentTime() {
  if (!hasDraftContent()) resetDraft();
  else if ($('#scope').value === 'shot' && state.draft.shotId !== state.shotId) { toast('正在编辑另一片段的批注，请先保存或取消编辑。'); return false; }
  const time = globalTime();
  $('#note-start').value = timecode(time); $('#note-end').value = timecode(time);
  return true;
}

function editNote(note) {
  if (state.uploading) { toast('附件正在上传，请完成后再切换批注。'); return; }
  if (hasUnsavedDraft() && !confirm('右侧有未保存的批注草稿。放弃草稿并打开这条批注？')) return;
  state.draft = structuredClone(note);
  $('#scope').value = note.scope; $('#note-start').value = timecode(note.time); $('#note-end').value = timecode(note.endTime); $('#note-text').value = note.text;
  $('#composer-title').textContent = '编辑批注'; $('#cancel-edit').hidden = false; $('#save-note').textContent = '保存修改'; $('#form-error').hidden = true;
  if (note.scope === 'shot') selectShot(note.shotId, note.time);
  else { state.mode = 'full'; $('#mode-full').classList.add('active'); $('#mode-shot').classList.remove('active'); loadPlayback(note.time); }
  player.pause(); renderDraft(); storeLocal(); $('#note-text').focus();
}

function renderNotes() {
  if (!state.document) return;
  const filter = $('#notes-filter').value;
  let notes = orderedNotes(state.document.notes);
  if (filter === 'current') notes = notes.filter(note => note.scope === 'global' || note.shotId === state.shotId);
  if (filter === 'open') notes = notes.filter(note => note.status !== 'done');
  if (filter === 'global') notes = notes.filter(note => note.scope === 'global');
  const list = document.createDocumentFragment();
  for (const note of notes) {
    const card = element('article', `note-card${note.status === 'done' ? ' done' : ''}`);
    const top = element('div', 'note-top');
    const latestNote = () => state.document.notes.find(item => item.id === note.id);
    const openNote = () => { const current = latestNote(); if (current) editNote(current); };
    const jump = element('button', 'note-time', `${timecode(note.time)}${note.endTime > note.time + .02 ? ` – ${timecode(note.endTime)}` : ''}`); jump.type = 'button'; jump.addEventListener('click', openNote);
    top.append(jump, element('span', 'note-scope', note.scope === 'global' ? '全片' : `镜头 ${String(note.shotId).padStart(2, '0')}`), element('span', 'note-status', note.status === 'done' ? '已完成' : '待修改'));
    const body = element('button', 'note-body', note.text); body.type = 'button'; body.addEventListener('click', openNote);
    card.append(top, body);
    if (note.region) card.append(element('span', 'note-scope', '含画面位置标记'));
    if (note.attachments?.length) {
      const files = element('div', 'note-attachments');
      for (const file of note.attachments) { const a = element('a', '', file.name); a.href = file.url || `/files/${file.path}`; a.target = '_blank'; a.rel = 'noopener'; files.append(a); }
      card.append(files);
    }
    const actions = element('div', 'note-actions');
    const done = element('button', '', note.status === 'done' ? '重新待修改' : '标为已完成'); done.type = 'button'; done.addEventListener('click', () => { const current = latestNote(); if (!current) return; current.status = current.status === 'done' ? 'open' : 'done'; current.updatedAt = new Date().toISOString(); changed(); });
    const edit = element('button', '', '编辑'); edit.type = 'button'; edit.addEventListener('click', openNote);
    const remove = element('button', '', '删除'); remove.type = 'button'; remove.addEventListener('click', () => { if (state.uploading) { toast('附件正在上传，请稍后删除或切换批注。'); return; } if (!confirm('删除这条批注？附件文件仍保留在本机。')) return; state.document.notes = state.document.notes.filter(item => item.id !== note.id); if (state.draft?.id === note.id) resetDraft(); changed(); });
    actions.append(done, edit, remove); card.append(actions); list.append(card);
  }
  if (!notes.length) list.append(element('div', 'empty-notes', filter === 'current' ? '这个片段还没有批注。\n暂停画面，记录需要改的地方。' : '这里还没有符合条件的批注。'));
  $('#notes').replaceChildren(list);
}

async function submitNote(event) {
  event.preventDefault();
  if (!state.ready || state.uploading) return;
  const draft = readDraft();
  const now = new Date().toISOString();
  const note = { id: draft.id || crypto.randomUUID(), scope: draft.scope, shotId: draft.scope === 'global' ? null : draft.shotId, time: draft.timeInput === timecode(draft.time) ? draft.time : parseTimecode(draft.timeInput), endTime: draft.endInput === timecode(draft.endTime) ? draft.endTime : parseTimecode(draft.endInput), region: draft.region, text: draft.text.trim(), attachments: draft.attachments, status: draft.status || 'open', createdAt: draft.createdAt || now, updatedAt: now };
  const error = validateNote(note, state.project);
  $('#form-error').textContent = error; $('#form-error').hidden = !error;
  if (error) return;
  const index = state.document.notes.findIndex(item => item.id === note.id);
  if (index < 0) state.document.notes.push(note); else state.document.notes[index] = note;
  resetDraft(globalTime()); changed(); toast(index < 0 ? '批注已加入清单' : '批注已更新');
}

async function uploadAttachments() {
  if (!state.ready) return;
  const files = [...$('#attachments').files];
  if (!files.length) return;
  const targetDraft = state.draft;
  state.uploading = true; $('#save-note').disabled = true; $('#attachments').disabled = true; $('#scope').disabled = true; $('#cancel-edit').disabled = true;
  let succeeded = 0;
  try {
    for (const file of files) {
      saveLabel(`正在添加附件 ${succeeded + 1}/${files.length}`);
      const uploaded = await api(`/api/upload?kind=annotation&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      if (state.draft !== targetDraft) throw new Error('批注已切换，附件已保存在本机但未挂到其他批注');
      targetDraft.attachments.push({ name: file.name, path: uploaded.path, url: uploaded.url, type: file.type || 'application/octet-stream' });
      succeeded++; renderDraft(); storeLocal();
    }
    saveLabel('附件已存本机 · 批注尚未提交');
  } catch (error) { toast(`附件添加失败：${error.message}。已成功的 ${succeeded} 个附件已保留。`); saveLabel('部分附件未添加', true); }
  finally { state.uploading = false; $('#save-note').disabled = false; $('#attachments').disabled = false; $('#scope').disabled = false; $('#cancel-edit').disabled = false; $('#attachments').value = ''; }
}

function downloadJSON() {
  const content = JSON.stringify({ ...state.document, project: { id: state.project.id, title: state.project.title, revision: state.project.revision, width: state.project.width, height: state.project.height, fps: state.project.fps, duration: state.project.duration } }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const a = element('a'); a.href = url; a.download = `${state.project.id}-批注.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyAll() {
  if (!state.ready) return;
  if (hasUnsavedDraft()) { toast('右侧有未提交的批注，请先点击“保存批注”。'); $('#note-text').focus(); return; }
  await persist();
  const text = exportReview(state.project, state.document);
  try { await navigator.clipboard.writeText(text); toast(`已复制全部 ${state.document.notes.length} 条批注，可直接发给助手`); }
  catch { $('#copy-text').value = text; $('#copy-dialog').showModal(); $('#copy-text').focus(); $('#copy-text').select(); }
}

async function startJob(action) {
  if (!state.ready || state.job) return;
  if (action === 'compose' && !confirm('合成当前已有的片段，生成完整视频。文字批注需要先交给助手修改，此按钮不会自动执行批注。继续合成？')) return;
  try {
    const data = await api('/api/review/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, shotIds: [] }) });
    state.job = data.job; $('#job-panel').hidden = false; $('#job-output').hidden = true; $('#prepare').disabled = true; $('#compose').disabled = true;
    pollJob();
  } catch (error) { toast(`任务未能开始：${error.message}`); }
}

async function pollJob() {
  if (!state.job) return;
  try {
    const data = await api(`/api/review/jobs/${encodeURIComponent(state.job.id)}`);
    state.job = data.job;
    $('#job-message').textContent = data.job.error || data.job.message || data.job.status;
    const progress = Number(data.job.progress) || 0;
    $('#job-progress').value = progress <= 1 ? progress * 100 : progress;
    if (data.job.status === 'done' || data.job.status === 'failed') {
      if (data.job.outputUrl) { $('#job-output').href = data.job.outputUrl; $('#job-output').target = '_blank'; $('#job-output').hidden = false; }
      if (data.job.status === 'done') {
        const time = globalTime(); state.project = await api('/api/review/project'); renderShots(); renderCounts(); updateTitle(); loadPlayback(time);
      }
      state.job = null; $('#prepare').disabled = false; $('#compose').disabled = false; return;
    }
  } catch (error) { $('#job-message').textContent = `读取任务状态失败：${error.message}，稍后重试。`; }
  setTimeout(pollJob, 1500);
}

player.addEventListener('loadedmetadata', applyPendingSeek);
player.addEventListener('loadeddata', () => { $('#player-placeholder').hidden = true; });
player.addEventListener('playing', () => { $('#player-placeholder').hidden = true; $('#play').textContent = '暂停'; setMarking(false); });
player.addEventListener('pause', () => { $('#play').textContent = '播放'; });
player.addEventListener('error', () => { showPlaceholder('视频载入失败', '请准备片段预览，或检查原视频文件是否存在。'); $('#preview-status').textContent = `播放失败 · ${player.error?.message || '请重试或准备片段'}`; });
player.addEventListener('timeupdate', () => {
  if (!state.project || state.seekOnLoad) return;
  const time = globalTime(); $('#clock').textContent = timecode(time); $('#seek').value = String(time);
  if (state.mode === 'full') {
    const shot = shotAt(state.project, time);
    if (shot && shot.id !== state.shotId) { state.shotId = shot.id; refreshShotActive(); updateTitle(); renderNotes(); drawRegion(); }
  } else if (time >= state.sourceEnd - .025 && !player.paused) {
    if ($('#auto-next').checked) moveShot(1, true); else { player.pause(); player.currentTime = Math.max(0, state.sourceEnd - state.sourceOffset - .034); }
  }
});
player.addEventListener('ended', () => { if (!state.seekOnLoad && state.mode === 'shot' && $('#auto-next').checked && globalTime() >= state.sourceEnd - .05) moveShot(1, true); });
$('#play').addEventListener('click', () => {
  if (!state.ready || !player.src) return;
  if (!player.paused) return player.pause();
  if (globalTime() >= state.sourceEnd - .04) player.currentTime = Math.max(0, state.sourceStart - state.sourceOffset);
  void player.play().catch(error => toast(`无法播放：${error.message}`));
  audioSync.sync({ force: true, fromGesture: true });
});
player.addEventListener('click', () => { if (!player.paused) player.pause(); });
$('#previous').addEventListener('click', () => moveShot(-1));
$('#next').addEventListener('click', () => moveShot(1));
$('#mode-shot').addEventListener('click', () => setMode('shot'));
$('#mode-full').addEventListener('click', () => setMode('full'));
$('#speed').addEventListener('change', () => { player.playbackRate = Number($('#speed').value); });
$('#seek').addEventListener('input', event => { if (!state.ready || player.readyState < 1) return; player.pause(); const time = Number(event.target.value); player.currentTime = clamp(time - state.sourceOffset, 0, Math.max(0, (player.duration || 0) - .001)); $('#clock').textContent = timecode(time); });
$('#shot-search').addEventListener('input', renderShots);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { state.shotFilter = button.dataset.filter; for (const other of document.querySelectorAll('[data-filter]')) other.classList.toggle('active', other === button); renderShots(); });
$('#notes-filter').addEventListener('change', renderNotes);
$('#note-form').addEventListener('submit', submitNote);
$('#attachments').addEventListener('change', uploadAttachments);
$('#new-note').addEventListener('click', () => { if (!state.ready) return; player.pause(); if (!hasDraftContent()) resetDraft(); else toast('继续编辑右侧批注，保存后可添加下一条。'); $('#note-text').focus(); });
$('#cancel-edit').addEventListener('click', () => { if (state.uploading) { toast('请等待附件上传完成。'); return; } resetDraft(); });
$('#scope').addEventListener('change', () => {
  if (!state.ready) return;
  state.draft.scope = $('#scope').value;
  if ($('#scope').value === 'global') { $('#note-start').value = '00:00.00'; $('#note-end').value = timecode(state.project.duration); }
  else { state.draft.shotId = state.shotId; $('#note-start').value = timecode(clipStart(selectedShot(), state.project.fps)); $('#note-end').value = timecode(clipEnd(selectedShot(), state.project.fps)); }
  renderDraft(); storeLocal();
});
$('#use-time').addEventListener('click', () => { if (!state.ready) return; if (draftAtCurrentTime()) { renderDraft(); storeLocal(); } });
$('#use-shot').addEventListener('click', () => { if (!state.ready) return; const shot = draftShot() || selectedShot(); const start = $('#scope').value === 'global' ? 0 : clipStart(shot, state.project.fps); const end = $('#scope').value === 'global' ? state.project.duration : clipEnd(shot, state.project.fps); state.draft.time = start; state.draft.endTime = end; $('#note-start').value = timecode(start); $('#note-end').value = timecode(end); storeLocal(); });
for (const selector of ['#note-text', '#note-start', '#note-end']) $(selector).addEventListener('input', () => { $('#form-error').hidden = true; storeLocal(); });
$('#mark').addEventListener('click', () => { if (!state.ready) return; if (state.marking) return setMarking(false); if (draftAtCurrentTime()) setMarking(true); });
$('#clear-region').addEventListener('click', () => { state.draft.region = null; renderDraft(); storeLocal(); });
const pointerPosition = event => { const bounds = $('#marker-layer').getBoundingClientRect(); return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) }; };
$('#marker-layer').addEventListener('pointerdown', event => { if (!state.marking) return; player.pause(); state.drag = pointerPosition(event); $('#marker-layer').setPointerCapture(event.pointerId); state.draft.region = { ...state.drag, w: 0, h: 0 }; drawRegion(); });
$('#marker-layer').addEventListener('pointermove', event => { if (!state.drag) return; state.draft.region = normalizeRegion(state.drag, pointerPosition(event)); drawRegion(); });
$('#marker-layer').addEventListener('pointerup', event => { if (!state.drag) return; state.draft.region = normalizeRegion(state.drag, pointerPosition(event)); state.drag = null; $('#marker-layer').releasePointerCapture(event.pointerId); setMarking(false); renderDraft(); storeLocal(); $('#note-text').focus(); });
$('#marker-layer').addEventListener('pointercancel', () => { state.drag = null; setMarking(false); });
$('#copy-all').addEventListener('click', copyAll);
$('#export-json').addEventListener('click', () => { if (!state.ready) return; if (hasUnsavedDraft()) { toast('右侧有未提交的草稿，请先保存批注再导出。'); return; } downloadJSON(); });
$('#close-dialog').addEventListener('click', () => $('#copy-dialog').close());
$('#select-copy-text').addEventListener('click', () => { $('#copy-text').focus(); $('#copy-text').select(); });
$('#prepare').addEventListener('click', () => startJob('prepare'));
$('#compose').addEventListener('click', () => startJob('compose'));
window.addEventListener('beforeunload', () => { storeLocal(); });
window.addEventListener('online', () => { if (state.saveRevision > state.savedRevision) void persist(); });

async function init() {
  try {
    state.project = await api('/api/review/project');
    if (!state.project.shots?.length) throw new Error('工程没有镜头清单');
    let serverNotes;
    try { serverNotes = await api('/api/review/notes'); } catch (error) { serverNotes = null; toast(`批注服务暂不可用：${error.message}`); }
    let local;
    try { local = JSON.parse(localStorage.getItem(storageKey()) || 'null'); } catch {}
    state.document = serverNotes || { version: 1, projectId: state.project.id, projectRevision: state.project.revision, revision: 0, notes: [], updatedAt: new Date().toISOString() };
    if (local?.document?.projectId === state.project.id && (local.dirty || !serverNotes)) { state.document = local.document; state.saveRevision = 1; toast('已恢复尚未同步的本地批注'); }
    state.document.notes ||= [];
    state.shotId = state.project.shots[0].id;
    $('#project-title').textContent = `${state.project.title} · ${state.project.width}×${state.project.height} · ${state.project.fps} fps`;
    $('#video-wrap').style.aspectRatio = `${state.project.width} / ${state.project.height}`;
    resetDraft(0);
    if (local?.draft && (local.draft.text?.trim() || local.draft.attachments?.length || local.draft.id || local.draft.region)) {
      const d = local.draft; state.draft = d; $('#scope').value = d.scope || 'shot'; $('#note-text').value = d.text || ''; $('#note-start').value = d.timeInput || timecode(d.time); $('#note-end').value = d.endInput || timecode(d.endTime);
      if (d.id) { $('#composer-title').textContent = '编辑批注'; $('#cancel-edit').hidden = false; $('#save-note').textContent = '保存修改'; }
      renderDraft(); toast('已恢复右侧未提交的批注草稿');
    }
    renderCounts(); renderShots(); renderNotes(); updateTitle(); loadPlayback(0); state.ready = true;
    if (state.saveRevision > state.savedRevision) void persist(); else if (serverNotes) saveLabel('全部批注已保存'); else saveLabel('批注服务未连接 · 本地模式', true);
  } catch (error) { saveLabel('工程加载失败', true); $('#project-title').textContent = error.message; showPlaceholder('工程未能加载', error.message); $('#play').disabled = true; toast(`加载失败：${error.message}`); }
}

void init();
