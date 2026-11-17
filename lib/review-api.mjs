import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createReviewStore, formatReviewExport, ReviewError } from './review-store.mjs';

export async function readJSON(req, limit = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ReviewError('批注数据过大，请减少内容或分次提交', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ReviewError('JSON 数据无效'); }
}

export function createReviewAPI({ projectRoot, dataRoot, libRoot, json, engine: injectedEngine }) {
  let projectCache = null, cacheAt = 0;
  const jobs = new Map(); let activeJob = null;
  const engine = async () => injectedEngine || await import('./segments.mjs');
  const previewPath = id => path.join(dataRoot, 'reviews', `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}-preview.json`);
  async function readPreview(id, raw) {
    let saved;
    try { saved = JSON.parse(await fs.readFile(previewPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const relative = saved.output;
    const validPath = typeof relative === 'string' && /^outputs\/[\p{L}\p{N}._-]+\.mp4$/u.test(relative);
    const matches = saved.revision === raw.revision && raw.shots.every(shot => shot.available && !shot.stale && saved.segmentHashes?.[shot.id] === shot.fileSHA256);
    if (!validPath || !matches) return { current: false, createdAt: saved.createdAt };
    try { if (!(await fs.stat(path.join(dataRoot, relative))).isFile()) return { current: false }; }
    catch (error) { if (error.code === 'ENOENT') return { current: false }; throw error; }
    return { ...saved, current: true, url: `/files/outputs/${encodeURIComponent(path.basename(relative))}` };
  }
  async function savePreview(project, result, output) {
    if (!output) return;
    const full = path.resolve(output), outputs = path.resolve(dataRoot, 'outputs');
    if (path.dirname(full) !== outputs) throw new Error('合成结果路径不在输出目录');
    const current = await (await engine()).loadSegmentManifest(projectRoot, { dataRoot });
    if (current.revision !== project.revision || current.shots.some(shot => !shot.available || shot.stale || (result.segmentHashes && result.segmentHashes[shot.id] !== shot.fileSHA256))) throw new Error('合成后工程或片段已变化，请重新核对片段');
    const saved = { version: 1, revision: current.revision, output: `outputs/${path.basename(full)}`,
      segmentHashes: Object.fromEntries(current.shots.map(shot => [shot.id, shot.fileSHA256])),
      createdAt: result.createdAt || new Date().toISOString() };
    const target = previewPath(project.id), temporary = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, JSON.stringify(saved, null, 2), 'utf8'); await fs.rename(temporary, target); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  }
  async function getProject(force = false) {
    if (!force && projectCache && Date.now() - cacheAt < 1500) return projectCache;
    const raw = await (await engine()).loadSegmentManifest(projectRoot, { dataRoot });
    const timeline = raw.shots || [];
    const id = raw.projectId || raw.id || path.basename(projectRoot);
    const revision = raw.revision || raw.projectRevision || createHash('sha256').update(JSON.stringify(timeline.map(s=>({id:s.id,startFrame:s.startFrame,endFrame:s.endFrame,dependencyKey:s.dependencyKey})))).digest('hex');
    const preview = await readPreview(id, { ...raw, revision });
    const fullVideoUrl = preview?.current ? preview.url : raw.baselineUrl || raw.baselineVideoUrl || raw.fullVideoUrl || '/review-media/master.mp4';
    projectCache = { ...raw, id, title: raw.title || path.basename(projectRoot) + ' · 分镜批注', revision,
      width: raw.width || 1920, height: raw.height || 1080, fps: raw.fps || 30,
      duration: raw.duration || timeline.at(-1)?.end || 0, shots: timeline,
      fullVideoUrl, fullPreviewKind: preview?.current ? 'composed' : 'baseline',
      fullPreviewCurrent: preview?.current ?? false, fullPreviewCreatedAt: preview?.createdAt || null,
      sourcePreviewUrl: '/source-editor.html' };
    cacheAt = Date.now(); return projectCache;
  }
  const store = createReviewStore({ dataRoot, getProject });
  async function runJob(body) {
    if (activeJob && ['queued','running'].includes(activeJob.status)) throw new ReviewError('已有分段任务在运行，请等它结束', 409);
    if (!['prepare','render','compose'].includes(body.action)) throw new ReviewError('任务类型无效');
    const project = await getProject(true);
    const shotIds = Array.isArray(body.shotIds) ? [...new Set(body.shotIds.map(Number))] : [];
    if (body.action === 'render' && (!shotIds.length || shotIds.some(id=>!project.shots.some(s=>s.id===id)))) throw new ReviewError('请选择有效的返修镜头');
    const job = { id: randomUUID(), action: body.action, status:'queued', progress:0, message:'准备任务', createdAt:new Date().toISOString(),shotIds };
    jobs.set(job.id, job); activeJob = job;
    setImmediate(async () => {
      job.status = 'running';
      try {
        const mod = await engine();
        const onProgress = update => {
          if (typeof update === 'string') job.message = update;
          else if (update) { if (Number.isFinite(update.progress)) job.progress=Math.max(0,Math.min(1,update.progress)); if (update.message) job.message=update.message; }
        };
        const options = { dataRoot, libRoot, onProgress };
        let result;
        if (body.action === 'prepare') result = await mod.initializeSegmentCache(projectRoot, options);
        if (body.action === 'render') result = await mod.renderSelectedSegments(projectRoot, { ...options, shotIds });
        if (body.action === 'compose') result = await mod.composeSegments(projectRoot, { ...options, outputName:`review-composed-${Date.now()}.mp4` });
        const output = result?.outputPath || result?.output;
        if (body.action === 'compose') await savePreview(project, result, output);
        job.result = result; job.status = 'done'; job.progress=1; job.message=body.action==='compose'?'整体视频已生成':'片段已准备';
        job.outputUrl = result?.url || result?.outputUrl || (output ? `/files/outputs/${encodeURIComponent(path.basename(output))}` : null);
        projectCache = null;
      } catch (error) { job.status='failed'; job.error=error.message || String(error); job.message='任务失败，原有视频保留'; }
      finally { job.finishedAt=new Date().toISOString(); if (activeJob===job) activeJob=null; }
    });
    return job;
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/review/')) return false;
    if (req.method === 'GET' && url.pathname === '/api/review/project') {
      json(res,200,await getProject()); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/review/notes') {
      json(res,200,await store.read()); return true;
    }
    if (req.method === 'PUT' && url.pathname === '/api/review/notes') {
      json(res,200,{ok:true,document:await store.save(await readJSON(req))}); return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/review/export') {
      const project=await getProject(); const document=await store.read(project);
      json(res,200,{text:formatReviewExport(project,document,{dataRoot,projectRoot}),document}); return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/review/jobs') {
      json(res,202,{ok:true,job:await runJob(await readJSON(req,32768))}); return true;
    }
    const match = /^\/api\/review\/jobs\/([a-f0-9-]+)$/.exec(url.pathname);
    if (req.method==='GET' && match) {
      const job=jobs.get(match[1]); if (!job) throw new ReviewError('任务不存在（服务重启后任务记录不保留）',404);
      json(res,200,{job}); return true;
    }
    json(res,404,{ok:false,error:'未找到批注接口'}); return true;
  }
  return { handle, getProject, store, jobs };
}
