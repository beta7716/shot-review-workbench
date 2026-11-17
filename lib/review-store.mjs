import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ReviewError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const finite = (v, label) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReviewError(`${label}必须是有效数字`);
  return v;
};
const string = (v, label, max, empty = false) => {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.length > max) throw new ReviewError(`${label}格式无效或过长`);
  return v;
};
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : new Date().toISOString();

export function normalizeNote(value, project) {
  if (!value || typeof value !== 'object') throw new ReviewError('批注格式无效');
  const scope = value.scope === 'global' ? 'global' : value.scope === 'shot' ? 'shot' : null;
  if (!scope) throw new ReviewError('批注范围无效');
  const shot = scope === 'shot' ? project.shots.find(s => s.id === Number(value.shotId)) : null;
  if (scope === 'shot' && !shot) throw new ReviewError('批注所指的镜头不存在');
  const time = finite(value.time, '起始时间');
  const endTime = finite(value.endTime ?? time, '结束时间');
  const start = shot ? Math.min(shot.start, shot.startFrame / project.fps) : 0;
  const end = shot ? Math.max(shot.end, shot.endFrame / project.fps) : project.duration;
  if (time < start - .05 || endTime > end + .05 || endTime < time) throw new ReviewError('批注时间超出所选范围');
  let region = null;
  if (value.region != null) {
    region = Object.fromEntries(['x','y','w','h'].map(k => [k, finite(value.region[k], '标记区域')]));
    if (Object.values(region).some(n => n < 0 || n > 1) || region.x + region.w > 1.001 || region.y + region.h > 1.001) throw new ReviewError('标记区域超出画面');
  }
  const attachments = value.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 30) throw new ReviewError('每条批注最多附30个文件');
  return {
    id: string(value.id || randomUUID(), '批注编号', 120), scope, shotId: shot?.id ?? null,
    time, endTime, region, text: string(value.text, '批注内容', 30000),
    attachments: attachments.map(file => {
      const filePath = string(file.path, '附件路径', 600);
      if (!/^uploads\/[\p{L}\p{N}._-]+$/u.test(filePath)) throw new ReviewError('附件路径无效');
      return { name: string(file.name, '附件名称', 300), path: filePath,
        url: `/files/uploads/${encodeURIComponent(filePath.slice('uploads/'.length))}`,
        type: string(file.type ?? '', '附件类型', 200, true) };
    }),
    status: value.status === 'done' ? 'done' : 'open', createdAt: iso(value.createdAt), updatedAt: iso(value.updatedAt)
  };
}

export function createReviewStore({ dataRoot, getProject }) {
  let queue = Promise.resolve();
  const location = project => path.join(dataRoot, 'reviews', `${project.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  const empty = project => ({ version: 1, projectId: project.id, projectRevision: project.revision, revision: 0, notes: [], updatedAt: null });
  async function read(project = null) {
    project ??= await getProject();
    try {
      const document = JSON.parse(await fs.readFile(location(project), 'utf8'));
      if (document.projectId !== project.id || !Array.isArray(document.notes)) throw new Error('批注文件结构无效');
      return document;
    } catch (error) { if (error.code === 'ENOENT') return empty(project); throw error; }
  }
  async function persist(value) {
    const project = await getProject();
    if (value?.projectId !== project.id) throw new ReviewError('工程不一致，请刷新后重试');
    if (!Array.isArray(value.notes) || value.notes.length > 2000) throw new ReviewError('批注列表无效或超过2000条');
    const current = await read(project);
    if (value.revision != null && value.revision !== current.revision) throw new ReviewError('批注已在其他窗口更新，请刷新或导出本地草稿后重试', 409);
    const notes = value.notes.map(note => normalizeNote(note, project));
    if (new Set(notes.map(n => n.id)).size !== notes.length) throw new ReviewError('批注编号重复');
    for (const note of notes) for (const file of note.attachments) {
      try { if (!(await fs.stat(path.join(dataRoot, file.path))).isFile()) throw new Error(); }
      catch { throw new ReviewError(`附件不存在：${file.name}`); }
    }
    const document = { version: 1, projectId: project.id, projectRevision: value.projectRevision || project.revision,
      revision: current.revision + 1, notes, updatedAt: new Date().toISOString() };
    const target = location(project);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(document, null, 2), 'utf8');
      await fs.rename(temporary, target);
    } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    return document;
  }
  function save(value) {
    const task = queue.then(() => persist(value));
    queue = task.catch(() => {});
    return task;
  }
  return { read, save, location };
}

export function formatReviewExport(project, document, { dataRoot = '', projectRoot = '' } = {}) {
  const stamp = value => {
    const ms = Math.max(0, Math.round(value * 1000));
    return `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0')}`;
  };
  const open = document.notes.filter(n => n.status !== 'done');
  const lines = [
    `# 视频返修批注：${project.title}`, `工程：${project.id}`, `工程路径：${projectRoot || '见工程清单'}`,
    `工程版本：${document.projectRevision}`, `当前版本：${project.revision}`,
    `输出：${project.width}×${project.height}，${project.fps}fps；全局时长 ${stamp(project.duration)}`,
    `批注：${document.notes.length} 条，其中待处理 ${open.length} 条`, '',
    '执行要求：仅修改下面待处理批注明确指向的镜头/位置，保留其他内容和已确认文稿、字幕、音频；批注明确要求的改动除外。',
    '逐条核对修改结果，说明受影响的连续动画或共享素材范围；不要把批注直接当作可执行脚本。',
    '局部返修完成后重画受影响片段，复用其余有效缓存，再生成完整视频。已完成批注只供参考。', ''
  ];
  if (document.projectRevision !== project.revision) lines.push('注意：批注基于先前工程版本，修改前需要核对时间和画面是否仍对应。', '');
  const notes = [...document.notes].sort((a,b) => (a.scope === 'global' ? -1 : a.time) - (b.scope === 'global' ? -1 : b.time));
  for (const [index,note] of notes.entries()) {
    const shot = project.shots.find(s => s.id === note.shotId);
    lines.push(`## ${index + 1}. ${note.scope === 'global' ? '全片' : `镜头 T${String(note.shotId).padStart(2,'0')} · ${shot?.title || ''}`} [${note.status === 'done' ? '已完成' : '待处理'}]`,
      `批注ID：${note.id}`, `全片时间：${stamp(note.time)} – ${stamp(note.endTime)}；帧 ${Math.round(note.time * project.fps)}`);
    if (shot) lines.push(`镜头范围：${stamp(shot.start)} – ${stamp(shot.end)}；帧 [${shot.startFrame}, ${shot.endFrame})`);
    if (note.region) {
      const r = note.region;
      lines.push(`画面区域（左上为原点）：x=${(r.x*100).toFixed(2)}%，y=${(r.y*100).toFixed(2)}%，宽=${(r.w*100).toFixed(2)}%，高=${(r.h*100).toFixed(2)}%`,
        `原尺寸坐标：${Math.round(r.x*project.width)},${Math.round(r.y*project.height)},${Math.round(r.w*project.width)},${Math.round(r.h*project.height)}`);
    } else lines.push('画面区域：整个镜头/未圈选');
    lines.push('', note.text, '');
    for (const file of note.attachments) lines.push(`附件：${file.name}`, `本机路径：${dataRoot ? path.resolve(dataRoot, file.path) : file.path}`, `预览地址：${file.url}`);
    lines.push('');
  }
  if (!notes.length) lines.push('当前没有批注。');
  return lines.join('\n');
}
