import {readdir, readFile, lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directories = ['lib','public','scripts','test','examples','skills','.github'];
const roots = ['package.json','server.mjs','README.md','LICENSE','THIRD_PARTY.md','SEGMENTS.md','start.bat','start.ps1','start.sh','.gitignore','.gitattributes'];
const excluded = new Set(['out','node_modules','data','.git','editor-assets','__pycache__']);
const extensions = new Set(['.js','.mjs','.json','.md','.html','.css','.ps1','.bat','.sh','.yml','.yaml']);
const files = [];
async function walk(relative) {
  const full = path.join(root,relative);
  let info; try {info = await lstat(full);} catch(error) {if(error.code==='ENOENT')return; throw error;}
  if(info.isSymbolicLink()) throw new Error(`Release must not contain symlinks: ${relative}`);
  if(info.isDirectory()) {
    if(excluded.has(path.basename(relative)))return;
    for(const name of await readdir(full)) await walk(path.join(relative,name));
  } else {
    if(!roots.includes(relative) && !extensions.has(path.extname(relative)))throw new Error(`Unexpected release file: ${relative}`);
    if(info.size>2*1024*1024)throw new Error(`Unexpected large source file: ${relative}`);
    const content = await readFile(full,'utf8');
    const patterns = [/C:[\\/]Users[\\/][^\s"'<>]+[\\/]OpenBot[\\/]/i,/agent-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,/sk-[A-Za-z0-9_-]{24,}/,/gh[pousr]_[A-Za-z0-9]{20,}/,/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/];
    if(patterns.some(pattern=>pattern.test(content)))throw new Error(`Potential private content: ${relative}`);
    if(content.includes('\0') || content.includes('\ufffd'))throw new Error(`Invalid text encoding: ${relative}`);
    files.push({path:relative.replaceAll('\\','/'),content});
  }
}
for(const item of [...roots,...directories])await walk(item);
files.sort((a,b)=>a.path.localeCompare(b.path));
if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(files));
else console.log(`Release check passed: ${files.length} text files; generated media, data and dependencies excluded.`);
