import path from 'node:path';
import os from 'node:os';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PROJECT = path.join(ROOT, 'examples', 'demo');
export const DEFAULT_LIB = process.env.LEMO_OPUSCAR_HOME || path.join(os.homedir(), 'lemo-opuscar');

/** Configuration refers only to files inside the chosen, trusted local project. */
function relativeFile(value, label) {
  if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value) || path.win32.isAbsolute(value)) throw new Error(`${label} must be a project-relative file path`);
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some(part => part === '..') || normalized.includes('\0')) throw new Error(`${label} must stay inside the project`);
  return normalized;
}

export async function loadProjectConfig(projectRoot = process.env.VIDEO_PROJECT_ROOT || DEFAULT_PROJECT) {
  let input;
  try { input = JSON.parse((await readFile(path.join(projectRoot, 'review-project.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; input = {}; }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('review-project.json must be an object');
  if (input.version != null && input.version !== 1) throw new Error('Unsupported review-project.json version');
  if ((input.fps != null && input.fps !== 30) || (input.width != null && input.width !== 1920) || (input.height != null && input.height !== 1080)) throw new Error('The segment engine currently supports only 1920×1080 at 30 fps');
  const masterVideo = relativeFile(input.masterVideo ?? 'out/master.mp4', 'masterVideo');
  const renderAdapter = input.renderAdapter == null ? null : relativeFile(input.renderAdapter, 'renderAdapter');
  if (renderAdapter && !renderAdapter.endsWith('.mjs')) throw new Error('renderAdapter must point to a local .mjs module');
  if (input.title != null && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 300)) throw new Error('title must be a nonempty string of at most 300 characters');
  return {version: 1, title: input.title || path.basename(path.resolve(projectRoot)), masterVideo, renderAdapter, width: 1920, height: 1080, fps: 30};
}
