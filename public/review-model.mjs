export const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function timecode(seconds) {
  const millis = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const minutes = Math.floor(millis / 60000);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(millis / 1000) % 60).padStart(2, '0')}.${String(millis % 1000).padStart(3, '0')}`;
}

export function parseTimecode(value) {
  const source = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(source)) return Number(source);
  const match = source.match(/^(\d+):([0-5]?\d)(?:\.(\d{1,3}))?$/);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || '0'}`);
}

export function shotAt(project, time) {
  const shots = project?.shots || [];
  const fps = project?.fps || 30;
  // HTMLMediaElement can truncate a rational frame time to microseconds, e.g.
  // 1457/30 becomes 48.566666. Keep that timestamp on its displayed frame.
  const frame = Math.floor(Number(time) * fps + 1e-4);
  return shots.find(shot => frame >= Math.round(clipStart(shot, fps) * fps) && frame < Math.round(clipEnd(shot, fps) * fps)) || (time >= project?.duration ? shots.at(-1) : null);
}

export function clipStart(shot, fps = 30) {
  return (Number.isFinite(shot?.startFrame) ? shot.startFrame : Math.ceil((Number(shot?.start) || 0) * fps - 1e-7)) / fps;
}

export function clipEnd(shot, fps = 30) {
  return (Number.isFinite(shot?.endFrame) ? shot.endFrame : Math.ceil((Number(shot?.end) || 0) * fps - 1e-7)) / fps;
}

export function shotSeekTime(shot, time, fps = 30) {
  const start = clipStart(shot, fps);
  return clamp(time, start, Math.max(start, clipEnd(shot, fps) - 1 / fps));
}

export function normalizeRegion(a, b) {
  if (!a || !b) return null;
  const x = clamp(Math.min(a.x, b.x), 0, 1);
  const y = clamp(Math.min(a.y, b.y), 0, 1);
  const w = clamp(Math.max(a.x, b.x), 0, 1) - x;
  const h = clamp(Math.max(a.y, b.y), 0, 1) - y;
  return { x, y, w, h };
}

export function validateNote(note, project) {
  if (!String(note.text || '').trim()) return '请先填写修改说明。';
  if (!Number.isFinite(note.time) || !Number.isFinite(note.endTime)) return '时间格式不正确，请使用 00:12.50 或秒数。';
  const shot = note.scope === 'shot' ? project.shots.find(item => item.id === note.shotId) : null;
  if (note.scope === 'shot' && !shot) return '请选择需要批注的片段。';
  const start = shot ? Math.min(shot.start, clipStart(shot, project.fps)) : 0;
  const end = shot ? Math.max(shot.end, Number.isFinite(shot.endFrame) ? shot.endFrame / project.fps : shot.end) : project.duration;
  if (note.time < start - .05 || note.endTime > end + .05 || note.endTime < note.time) return `批注时间应在 ${timecode(start)}–${timecode(end)} 内，结束不能早于开始。`;
  if (note.region && ['x', 'y', 'w', 'h'].some(key => !Number.isFinite(note.region[key]) || note.region[key] < 0 || note.region[key] > 1)) return '标记区域无效，请重新框选。';
  return '';
}

export function orderedNotes(notes) {
  return [...notes].sort((a, b) => (Number(b.scope === 'global') - Number(a.scope === 'global')) || a.time - b.time || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function attachmentLocalPath(dataRoot, relativePath) {
  if (!dataRoot) return relativePath;
  const windows = /^[a-zA-Z]:[\\/]/.test(dataRoot) || /^\\\\/.test(dataRoot);
  const separator = windows ? '\\' : '/';
  const base = String(dataRoot).replace(/[\\/]+$/, '');
  return `${windows ? base.replace(/\//g, '\\') : base}${separator}${String(relativePath).replace(/^[\\/]+/, '').replace(/[\\/]/g, separator)}`;
}

export function previewStatus(project, usingClip, mode) {
  const current = project.fullPreviewKind === 'composed' && project.fullPreviewCurrent === true;
  if (usingClip) return current ? '片段缓存 · 同步最新合成音轨' : '片段缓存 · 同步原始整片音轨';
  const source = current ? '最新合成整片' : '原始整片 · 尚未合成当前片段';
  return mode === 'full' ? source : `片段尚未缓存 · ${source}对应区间`;
}

export function exportReview(project, document) {
  const notes = orderedNotes(document.notes || []);
  const lines = [
    '# 视频修改批注',
    `工程：${project.title}`,
    `工程 ID：${project.id}`,
    `工程路径：${project.projectRoot || '未提供，请结合工程 ID 定位'}`,
    `批注工程版本：${document.projectRevision || project.revision || '未标记'}`,
    `当前工程版本：${project.revision || '未标记'}`,
    `规格：${project.width}×${project.height}，${project.fps} fps；总时长 ${timecode(project.duration)}`,
    `批注：${notes.length} 条，待修改 ${notes.filter(note => note.status !== 'done').length} 条`,
    '',
    '请逐条处理待修改批注，仅修改指定镜头、时间范围和画面区域。保留未提到的镜头、文案、音频与时序；需要影响相邻片段或改变时长时先说明范围。修改后重做受影响片段、复用其他片段，再合成整体视频。已完成批注保留供核对，不重复执行。',
    ''
  ];
  if (document.projectRevision && project.revision && document.projectRevision !== project.revision) lines.push('注意：批注基于的工程版本与当前工程不同，修改前请核对镜头时间、画面与素材；不要把旧批注直接套入新版本。', '');
  if (!notes.length) lines.push('暂无批注。');
  notes.forEach((note, index) => {
    const shot = project.shots.find(item => item.id === note.shotId);
    lines.push(`## ${index + 1}. ${note.status === 'done' ? '[已完成]' : '[待修改]'} ${note.scope === 'global' ? '全片' : `镜头 ${String(note.shotId).padStart(2, '0')} · ${shot?.title || ''}`}`);
    lines.push(`批注 ID：${note.id}`);
    lines.push(`全片时间：${timecode(note.time)}–${timecode(note.endTime)}`);
    const lowerFrame = shot ? Math.round(clipStart(shot, project.fps) * project.fps) : 0;
    const upperFrame = shot ? Math.round(clipEnd(shot, project.fps) * project.fps) : Math.ceil(project.duration * project.fps - 1e-7);
    const frame = clamp(Math.floor(note.time * project.fps + 1e-7), lowerFrame, Math.max(lowerFrame, upperFrame - 1));
    const endFrame = clamp(Math.ceil(note.endTime * project.fps - 1e-7), note.endTime > note.time ? Math.min(upperFrame, frame + 1) : frame, upperFrame);
    lines.push(`全局帧：${note.endTime > note.time ? `[${frame}, ${endFrame})` : `${frame}（定位点）`}，帧率 ${project.fps} fps`);
    if (shot) {
      lines.push(`镜头内时间：${timecode(Math.max(0, note.time - clipStart(shot, project.fps)))}–${timecode(Math.max(0, note.endTime - clipStart(shot, project.fps)))}`);
      lines.push(`镜头帧范围：[${lowerFrame}, ${upperFrame})`);
    }
    if (note.region) {
      const r = note.region;
      lines.push(`画面区域（左上为原点，归一化）：x=${r.x.toFixed(4)}, y=${r.y.toFixed(4)}, w=${r.w.toFixed(4)}, h=${r.h.toFixed(4)}`);
      lines.push(`画面区域（${project.width}×${project.height} 像素）：x=${Math.round(r.x * project.width)}, y=${Math.round(r.y * project.height)}, w=${Math.round(r.w * project.width)}, h=${Math.round(r.h * project.height)}`);
    } else lines.push('画面区域：整个画面');
    lines.push('修改说明：', note.text.trim());
    for (const file of note.attachments || []) {
      lines.push(`附件：${file.name} | 本机素材：${file.path}${file.type ? ` | ${file.type}` : ''}`);
      lines.push(`附件绝对路径：${attachmentLocalPath(project.dataRoot, file.path)}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}
