import test from 'node:test';
import assert from 'node:assert/strict';
import { timecode, parseTimecode, shotAt, clipStart, clipEnd, shotSeekTime, normalizeRegion, validateNote, orderedNotes, exportReview, attachmentLocalPath, previewStatus } from '../public/review-model.mjs';

const project = { id: 'test', title: '测试工程', revision: 'r2', projectRoot: 'C:/Projects/片段工程', dataRoot: 'C:/Review Data/test', width: 1920, height: 1080, fps: 30, duration: 8, shots: [{ id: 1, title: '第一段', start: 0, end: 2.681, startFrame: 0, endFrame: 81 }, { id: 2, title: '第二段', start: 2.681, end: 8, startFrame: 81, endFrame: 240 }] };
test('timecode round-trips real edit times and rejects malformed values', () => {
  assert.equal(timecode(62.345), '01:02.345');
  assert.equal(timecode(48.542), '00:48.542');
  assert.equal(timecode(59.9996), '01:00.000');
  assert.equal(parseTimecode('01:02.345'), 62.345);
  assert.equal(parseTimecode('2.681'), 2.681);
  assert.ok(Number.isNaN(parseTimecode('00:72')));
  assert.ok(Number.isNaN(parseTimecode('abc')));
});
test('shot boundaries use next segment and frame-origin offsets remain exact', () => {
  assert.equal(shotAt(project, 2.681).id, 1);
  assert.equal(shotAt(project, 2.7).id, 2);
  assert.equal(shotAt(project, 8).id, 2);
  assert.equal(clipStart(project.shots[1], 30), 81 / 30);
  assert.equal(clipEnd(project.shots[1], 30), 240 / 30);
});
test('region drag normalizes reverse and outside points', () => {
  assert.deepEqual(normalizeRegion({ x: 1.2, y: .8 }, { x: -.2, y: .3 }), { x: 0, y: .3, w: 1, h: .5 });
});
test('notes reject empty text and cross-shot ranges', () => {
  const note = { scope: 'shot', shotId: 2, time: 3, endTime: 4, text: '替换为附件录屏' };
  assert.equal(validateNote(note, project), '');
  assert.match(validateNote({ ...note, text: '  ' }, project), /修改说明/);
  assert.match(validateNote({ ...note, time: 1 }, project), /批注时间/);
  assert.match(validateNote({ ...note, endTime: 2.9 }, project), /批注时间/);
});
test('copied review preserves all text, assets, statuses and precise coordinates', () => {
  const text = exportReview(project, { projectRevision: 'r1', notes: [{ id: 'n1', scope: 'shot', shotId: 2, time: 3, endTime: 4.5, text: '只换右边图片\n不要盖住字幕', status: 'open', region: { x: .5, y: .25, w: .4, h: .5 }, attachments: [{ name: '图片.png', path: 'uploads/test.png', type: 'image/png' }] }, { id: 'g1', scope: 'global', time: 0, endTime: 8, text: '全片底乐降低', status: 'done', attachments: [] }] });
  assert.match(text, /批注工程版本：r1/);
  assert.match(text, /当前工程版本：r2/);
  assert.ok(text.includes('工程路径：C:/Projects/片段工程'));
  assert.match(text, /批注基于的工程版本与当前工程不同/);
  assert.match(text, /全片时间：00:03.000–00:04.500/);
  assert.match(text, /全局帧：\[90, 135\)，帧率 30 fps/);
  assert.match(text, /镜头帧范围：\[81, 240\)/);
  assert.match(text, /x=960, y=270, w=768, h=540/);
  assert.match(text, /只换右边图片\n不要盖住字幕/);
  assert.match(text, /本机素材：uploads\/test.png/);
  assert.ok(text.includes('附件绝对路径：C:\\Review Data\\test\\uploads\\test.png'));
  assert.match(text, /\[已完成\] 全片/);
  assert.match(text, /待修改 1 条/);
});
test('editing an old boundary annotation stays on its shot and exported frames cannot spill back', () => {
  const boundary = { ...project, duration: 52, shots: [
    { id: 17, title: '前一镜头', start: 46, end: 48.542, startFrame: 1380, endFrame: 1457 },
    { id: 18, title: '目标镜头', start: 48.542, end: 49.765, startFrame: 1457, endFrame: 1493 },
    { id: 19, title: '后一镜头', start: 49.765, end: 52, startFrame: 1493, endFrame: 1560 }
  ] };
  const note = { id: 'old-note', scope: 'shot', shotId: 18, time: 48.54, endTime: 49.765, text: '修改本镜头', status: 'open' };
  const target = boundary.shots[1];
  const jump = shotSeekTime(target, note.time, boundary.fps);
  assert.equal(jump, 1457 / 30);
  assert.equal(shotAt(boundary, jump).id, 18);
  assert.equal(shotAt(boundary, 48.566666).id, 18, 'microsecond-truncated video time stays on the first visible frame');
  assert.equal(note.time, 48.54, 'seeking does not rewrite the original annotation');
  assert.equal(shotAt(boundary, 1493 / 30).id, 19);
  assert.equal(shotAt(boundary, 49.766666).id, 19, 'the next truncated frame boundary stays half-open');
  assert.equal(shotAt(boundary, shotSeekTime(target, 49.8, 30)).id, 18);
  const text = exportReview(boundary, { projectRevision: 'r2', notes: [note] });
  assert.match(text, /全局帧：\[1457, 1493\)/);
  assert.match(text, /全片时间：00:48.540–00:49.765/);
  const wholeShot = { ...note, time: parseTimecode(timecode(clipStart(target, 30))), endTime: parseTimecode(timecode(clipEnd(target, 30))) };
  assert.match(exportReview(boundary, { notes: [wholeShot] }), /全局帧：\[1457, 1493\)/);
});
test('point annotations keep an exact global frame and matching revisions do not warn', () => {
  const text = exportReview(project, { projectRevision: 'r2', notes: [{ id: 'point', scope: 'shot', shotId: 2, time: 4, endTime: 4, text: '修改这个位置', status: 'open' }] });
  assert.match(text, /全局帧：120（定位点），帧率 30 fps/);
  assert.doesNotMatch(text, /批注基于的工程版本与当前工程不同/);
});
test('attachment paths preserve Windows drive, UNC and POSIX roots', () => {
  assert.equal(attachmentLocalPath('C:/A B/review/', '/uploads/a.png'), 'C:\\A B\\review\\uploads\\a.png');
  assert.equal(attachmentLocalPath('\\\\server\\share\\review\\', 'uploads/a.png'), '\\\\server\\share\\review\\uploads\\a.png');
  assert.equal(attachmentLocalPath('/tmp/review/', 'uploads\\a.png'), '/tmp/review/uploads/a.png');
  assert.equal(attachmentLocalPath('', 'uploads/a.png'), 'uploads/a.png');
});
test('preview labels distinguish the latest composed film from a baseline fallback', () => {
  assert.equal(previewStatus({ fullPreviewKind: 'composed', fullPreviewCurrent: true }, false, 'full'), '最新合成整片');
  assert.equal(previewStatus({ fullPreviewKind: 'baseline', fullPreviewCurrent: false }, false, 'full'), '原始整片 · 尚未合成当前片段');
  assert.match(previewStatus({ fullPreviewKind: 'composed', fullPreviewCurrent: false }, false, 'shot'), /原始整片/);
  assert.equal(previewStatus({}, true, 'shot'), '片段缓存 · 同步原始整片音轨');
});
test('all global notes precede shot notes and retain deterministic ordering', () => {
  const notes = [{ id: 's', scope: 'shot', time: 0, createdAt: '2026-01-01' }, { id: 'g2', scope: 'global', time: 0, createdAt: '2026-01-02' }, { id: 'g1', scope: 'global', time: 0, createdAt: '2026-01-01' }];
  assert.deepEqual(orderedNotes(notes).map(note => note.id), ['g1', 'g2', 's']);
});
