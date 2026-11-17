import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { streamFile } from './lib/http-files.mjs';
import { createReviewAPI } from './lib/review-api.mjs';
import { readJSON } from './lib/review-api.mjs';
import { DEFAULT_PROJECT, DEFAULT_LIB, loadProjectConfig } from './lib/project-config.mjs';
import { allowLocalRequest } from './lib/request-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PROJECT_ROOT = path.resolve(process.env.VIDEO_PROJECT_ROOT || DEFAULT_PROJECT);
const DATA = path.resolve(process.env.VIDEO_REVIEW_DATA_ROOT || path.join(HERE, 'data'));
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'outputs');
const PROJECT_ASSETS = path.join(PROJECT_ROOT, 'editor-assets');
const PORT = Number(process.env.PORT || 4318);
const LIB_ROOT = process.env.LEMO_OPUSCAR_HOME || DEFAULT_LIB;
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('PORT must be an integer from 0 to 65535');

await fsp.mkdir(UPLOADS, { recursive: true });
await fsp.mkdir(OUTPUTS, { recursive: true });

function safeName(name, fallback = 'asset.bin') {
  const base = path.basename(name || fallback).replace(/[^\p{L}\p{N}._-]+/gu, '_');
  return base || fallback;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg'
    , '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.mjs': 'text/javascript; charset=utf-8'
  })[ext] || 'application/octet-stream';
}

function inside(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(err || `${cmd} exited ${code}`)));
  });
}

async function upload(req, res, url) {
  const kind = ['base','annotation'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'replacement';
  const filename = safeName(url.searchParams.get('name'), `${kind}-${Date.now()}.bin`);
  const stored = `${Date.now()}-${randomUUID()}-${filename}`;
  const target = path.join(UPLOADS, stored);
  await pipeline(req, fs.createWriteStream(target));
  json(res, 200, { ok: true, kind, path: `uploads/${stored}`, url: `/files/uploads/${encodeURIComponent(stored)}` });
}

async function render(req, res) {
  const body = await readJSON(req);
  const base = path.resolve(DATA, body.base || '');
  if (!inside(DATA, base) || !fs.existsSync(base)) throw new Error('基础视频不存在');
  const width = Math.max(2, Math.round(Number(body.width) || 1920));
  const height = Math.max(2, Math.round(Number(body.height) || 1080));
  const edits = Array.isArray(body.edits) ? body.edits : [];
  if (!edits.length) throw new Error('还没有添加替换项');
  const previewStart = Math.max(0, Number(body.previewStart) || 0);
  const previewEnd = Number.isFinite(Number(body.previewEnd)) && Number(body.previewEnd) > previewStart ? Number(body.previewEnd) : null;
  const clipDuration = previewEnd ? previewEnd - previewStart : null;

  const args = ['-y'];
  if (previewStart > 0) args.push('-ss', String(previewStart));
  args.push('-i', base);
  const filters = [`[0:v]setpts=PTS-STARTPTS[v0]`];
  let previous = 'v0';
  edits.forEach((edit, i) => {
    const asset = path.resolve(DATA, edit.assetPath || '');
    if (!inside(DATA, asset) || !fs.existsSync(asset)) throw new Error(`替换素材不存在: ${edit.assetPath}`);
    const ext = path.extname(asset).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    const sourceOffset = previewStart > (Number(edit.start) || 0) ? previewStart - (Number(edit.start) || 0) : 0;
    if (isImage) args.push('-loop', '1', '-i', asset);
    else {
      if (sourceOffset > 0) args.push('-ss', String(sourceOffset));
      args.push('-stream_loop', '-1', '-i', asset);
    }
    const x = Math.round(Math.max(0, Math.min(1, Number(edit.x) || 0)) * width);
    const y = Math.round(Math.max(0, Math.min(1, Number(edit.y) || 0)) * height);
    const w = Math.max(2, Math.round(Math.max(.01, Math.min(1, Number(edit.w) || .25)) * width));
    const h = Math.max(2, Math.round(Math.max(.01, Math.min(1, Number(edit.h) || .25)) * height));
    const start = Math.max(0, (Number(edit.start) || 0) - previewStart);
    const end = Math.max(start + .01, (Number(edit.end) || (Number(edit.start) || 0) + 1) - previewStart);
    const fit = edit.fit === 'cover' ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`;
    const ov = `ov${i}`;
    const out = `v${i + 1}`;
    filters.push(`[${i + 1}:v]setpts=PTS-STARTPTS,${fit},format=rgba[${ov}]`);
    filters.push(`[${previous}][${ov}]overlay=${x}:${y}:enable='between(t,${start},${end})':eof_action=pass[${out}]`);
    previous = out;
  });

  const outputName = safeName(body.outputName, `edited-${Date.now()}.mp4`).replace(/\.[^.]+$/, '') + '.mp4';
  const output = path.join(OUTPUTS, outputName);
  args.push('-filter_complex', filters.join(';'), '-map', `[${previous}]`, '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest');
  if (clipDuration) args.push('-t', String(clipDuration));
  args.push(output);
  await run('ffmpeg', args);
  json(res, 200, { ok: true, output: `outputs/${outputName}`, url: `/files/outputs/${encodeURIComponent(outputName)}` });
}

async function sourceRender(req, res) {
  const body = await readJSON(req);
  const edits = Array.isArray(body.edits) ? body.edits : [];
  if (!edits.length) throw new Error('请先添加至少一个源工程替换项');

  const config = await loadProjectConfig(PROJECT_ROOT);
  const build = path.join(PROJECT_ROOT, 'build.ps1');
  if (!fs.existsSync(build)) {
    const error = new Error('此工程未接入旧版 build.ps1 组件导出；请使用分段 renderAdapter 或外部渲染器生成片段。');
    error.status = 400;
    throw error;
  }
  await fsp.mkdir(PROJECT_ASSETS, { recursive: true });
  const stamp = Date.now();
  const mapped = [];
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const source = path.resolve(DATA, edit.assetPath || '');
    if (!inside(DATA, source) || !fs.existsSync(source)) throw new Error(`替换素材不存在：${edit.assetPath || ''}`);
    const stored = `${stamp}-${i}-${safeName(edit.assetName || path.basename(source))}`;
    const target = path.join(PROJECT_ASSETS, stored);
    await fsp.copyFile(source, target);
    const copy = { ...edit, assetPath: `editor-assets/${stored}` };
    delete copy.assetUrl;
    mapped.push(copy);
  }

  await fsp.writeFile(path.join(PROJECT_ROOT, 'editor-edits.json'), JSON.stringify({ version: 2, edits: mapped }, null, 2), 'utf8');
  const rendered = path.resolve(PROJECT_ROOT, config.masterVideo);
  const before = fs.existsSync(rendered) ? fs.statSync(rendered).mtimeMs : null;
  await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', build, '-Lib', LIB_ROOT, '-Workers', '3', '-Query', 'edits=editor-edits.json', '-SkipQA', '-SkipPack']);
  if (!fs.existsSync(rendered) || fs.statSync(rendered).mtimeMs === before) throw new Error('源工程渲染未更新 review-project.json 指定的 masterVideo，请核对 build.ps1 输出。');
  const outputName = safeName(body.outputName || `source-edited-${stamp}.mp4`).replace(/\.[^.]+$/, '') + '.mp4';
  const destination = path.join(OUTPUTS, outputName);
  await fsp.copyFile(rendered, destination);
  json(res, 200, { ok: true, output: `outputs/${outputName}`, url: `/files/outputs/${encodeURIComponent(outputName)}` });
}

async function serveFile(req, res, file) {
  if (!inside(DATA, file) && !inside(PUBLIC, file) && !inside(PROJECT_ROOT, file)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const resolved = await fsp.realpath(file);
  const roots = await Promise.all([DATA, PUBLIC, PROJECT_ROOT].map(root => fsp.realpath(root)));
  if (!roots.some(root => inside(root, resolved))) return json(res, 403, { error: 'forbidden' });
  if (inside(UPLOADS, file) && !['.png','.jpg','.jpeg','.webp','.mp4','.webm','.mov','.wav','.mp3','.m4a'].includes(path.extname(file).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
  streamFile(req, res, file, mime(file));
}

const review = createReviewAPI({ projectRoot: PROJECT_ROOT, dataRoot: DATA, libRoot: LIB_ROOT, json });

const server = http.createServer(async (req, res) => {
  try {
    if (!allowLocalRequest(req, server.address().port)) return json(res, 403, { ok: false, error: '只允许本机同源请求' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.url.startsWith('/api/upload?') && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: '此接口需要 application/json' });
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'shot-review-workbench', version: '0.3.0', projectRoot: PROJECT_ROOT, dataRoot: DATA });
    if (await review.handle(req,res,url)) return;
    if (req.method === 'POST' && url.pathname === '/api/upload') return await upload(req, res, url);
    if (req.method === 'POST' && url.pathname === '/api/render') return await render(req, res);
    if (req.method === 'POST' && url.pathname === '/api/source-render') return await sourceRender(req, res);
    if (['GET','HEAD'].includes(req.method) && url.pathname === '/review-media/master.mp4') return await serveFile(req,res,path.resolve(PROJECT_ROOT,(await loadProjectConfig(PROJECT_ROOT)).masterVideo));
    if (['GET','HEAD'].includes(req.method) && url.pathname.startsWith('/files/')) return await serveFile(req,res, path.resolve(DATA, decodeURIComponent(url.pathname.slice('/files/'.length))));
    if (['GET','HEAD'].includes(req.method) && url.pathname.startsWith('/project/')) return await serveFile(req,res, path.resolve(PROJECT_ROOT, decodeURIComponent(url.pathname.slice('/project/'.length))));
    const relative = url.pathname === '/' ? 'review.html' : url.pathname.replace(/^\/+/, '');
    return await serveFile(req,res, path.resolve(PUBLIC, relative));
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    json(res, error.status || 500, { ok: false, error: error.message || String(error) });
  }
});

server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(PORT, '127.0.0.1', () => console.log(`Shot Review Workbench: http://127.0.0.1:${server.address().port}`));
