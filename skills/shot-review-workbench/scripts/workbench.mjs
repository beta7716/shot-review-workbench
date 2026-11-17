#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const REPOSITORY = 'https://github.com/beta7716/shot-review-workbench.git';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const action = args.shift() || 'locate';
const take = flag => {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
  return args.splice(index, 2)[1];
};
const command = (name, values) => new Promise((resolve, reject) => {
  const child = spawn(name, values, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${name} failed (${code}): ${stderr.trim()}`)));
});

async function inspect(directory) {
  const root = path.resolve(directory);
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
  if (pkg.name !== 'shot-review-workbench') return null;
  for (const file of ['server.mjs', 'public/review.html', 'lib/segments.mjs']) {
    try { if (!(await fs.stat(path.join(root, file))).isFile()) return null; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  let commit = null;
  try {
    const gitRoot = await command('git', ['-C', root, 'rev-parse', '--show-toplevel']);
    const sameRoot = process.platform === 'win32'
      ? path.resolve(gitRoot).toLowerCase() === root.toLowerCase()
      : path.resolve(gitRoot) === root;
    if (sameRoot) commit = await command('git', ['-C', root, 'rev-parse', 'HEAD']);
  } catch {}
  return {root, version: pkg.version || null, commit, repository: REPOSITORY, started: false};
}

try {
  if (['help', '--help', '-h'].includes(action)) {
    console.log('Usage: workbench.mjs locate [--home path]\n       workbench.mjs clone [--home path] [--ref main]\nLocates or clones the workbench only. Does not run it or update existing directories.');
  } else {
    const explicit = take('--home'), ref = take('--ref') || 'main';
    if (args.length) throw new Error(`Unknown arguments: ${args.join(' ')}`);
    if (!['locate', 'clone'].includes(action)) throw new Error(`Unknown action: ${action}`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) || ref.includes('..')) throw new Error('Invalid Git branch or tag');
    const selected = explicit || process.env.SHOT_REVIEW_WORKBENCH_HOME;
    if (action === 'locate') {
      const candidates = selected ? [selected] : [process.cwd(), path.join(process.cwd(), 'shot-review-workbench'), path.resolve(HERE, '../../..'), path.join(os.homedir(), 'shot-review-workbench')];
      let found = null;
      for (const directory of candidates) { found = await inspect(directory); if (found) break; }
      if (!found) throw new Error('Workbench not found. Set SHOT_REVIEW_WORKBENCH_HOME or use clone --home <new-directory>.');
      console.log(JSON.stringify(found, null, 2));
    } else {
      const destination = path.resolve(selected || path.join(os.homedir(), 'shot-review-workbench'));
      let present = false;
      try { await fs.lstat(destination); present = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (present) {
        const existing = await inspect(destination);
        if (!existing) throw new Error(`Destination exists and is not a workbench: ${destination}. Choose a new directory.`);
        console.log(JSON.stringify({...existing, cloned: false, updated: false}, null, 2));
      } else {
        await fs.mkdir(path.dirname(destination), {recursive: true});
        await command('git', ['clone', '--single-branch', '--branch', ref, '--', REPOSITORY, destination]);
        const cloned = await inspect(destination);
        if (!cloned) throw new Error(`Cloned repository is not a complete workbench: ${destination}`);
        console.log(JSON.stringify({...cloned, cloned: true, ref}, null, 2));
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
