import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

test('standalone server uses chosen project/data, isolates browser writes and downloads active attachments',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'shot-review-server-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),data=path.join(root,'data');
  await mkdir(path.join(project,'out'),{recursive:true});
  await writeFile(path.join(project,'timeline.json'),JSON.stringify([{id:1,start:0,end:1,title:'One'}]));
  await writeFile(path.join(project,'review-project.json'),JSON.stringify({version:1,title:'Chosen film',masterVideo:'out/chosen.mp4'}));
  await writeFile(path.join(project,'out/chosen.mp4'),'0123456789');
  const child=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,PORT:'0',VIDEO_PROJECT_ROOT:project,VIDEO_REVIEW_DATA_ROOT:data},windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode!==null)return;const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;});
  const base=await new Promise((resolve,reject)=>{
    let text='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),5000);
    child.once('error',reject);child.once('exit',code=>reject(new Error(`Server exited ${code}`)));
    child.stdout.on('data',chunk=>{text+=chunk;const match=/http:\/\/127\.0\.0\.1:\d+/.exec(text);if(match){clearTimeout(timer);resolve(match[0]);}});
  });
  const health=await(await fetch(base+'/api/health')).json();
  assert.equal(health.service,'shot-review-workbench');assert.equal(health.projectRoot,project);assert.equal(health.dataRoot,data);assert.equal(health.ffmpeg,undefined);
  const info=await(await fetch(base+'/api/review/project')).json();assert.equal(info.title,'Chosen film');
  const media=await fetch(base+'/review-media/master.mp4',{headers:{range:'bytes=2-5'}});assert.equal(media.status,206);assert.equal(await media.text(),'2345');
  const denied=await fetch(base+'/api/upload?name=bad.html',{method:'POST',headers:{Origin:'https://other.example'},body:'bad'});assert.equal(denied.status,403);
  const invalid=await fetch(base+'/api/review/notes',{method:'PUT',body:'{}'});assert.equal(invalid.status,415);
  const uploaded=await(await fetch(base+'/api/upload?kind=annotation&name=sample.html',{method:'POST',body:'<script>bad()</script>'})).json();
  const download=await fetch(base+uploaded.url);assert.equal(download.status,200);assert.equal(download.headers.get('content-disposition'),'attachment');
  assert.equal(download.headers.get('x-content-type-options'),'nosniff');
});
