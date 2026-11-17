import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createReviewAPI } from '../lib/review-api.mjs';
import { streamFile } from '../lib/http-files.mjs';

test('review API round trip, conflicts, export, jobs and native video ranges', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-api-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dataRoot=path.join(root,'data');await fs.mkdir(dataRoot);
  const video=path.join(root,'fixture.mp4');await fs.writeFile(video,Buffer.from('0123456789'));
  const manifest={projectId:'test',revision:'abc',duration:3,width:1920,height:1080,fps:30,baselineVideoUrl:'/baseline.mp4',shots:[{id:1,title:'开头',start:0,end:3,startFrame:0,endFrame:90,dependencyKey:'key',available:true,stale:false,fileSHA256:'clip-hash'}]};
  const engine={loadSegmentManifest:async()=>manifest,initializeSegmentCache:async()=>({count:1}),composeSegments:async()=>{const outputPath=path.join(dataRoot,'outputs','whole.mp4');await fs.mkdir(path.dirname(outputPath),{recursive:true});await fs.writeFile(outputPath,'composed');return{outputPath};},renderSelectedSegments:async(_p,options)=>({shotIds:options.shotIds})};
  const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const api=createReviewAPI({projectRoot:root,dataRoot,libRoot:root,json,engine});
  const server=http.createServer(async(req,res)=>{
    try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/video')return streamFile(req,res,video,'video/mp4');if(await api.handle(req,res,url))return;json(res,404,{});}catch(e){json(res,e.status||500,{error:e.message});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const project=await (await fetch(base+'/api/review/project')).json();assert.equal(project.id,'test');
  const doc=await(await fetch(base+'/api/review/notes')).json();
  doc.notes.push({id:'note1',scope:'shot',shotId:1,time:1,endTime:1.5,text:'此处换图',attachments:[]});
  const saved=await(await fetch(base+'/api/review/notes',{method:'PUT',body:JSON.stringify(doc)})).json();assert.equal(saved.document.revision,1);
  const conflict=await fetch(base+'/api/review/notes',{method:'PUT',body:JSON.stringify(doc)});assert.equal(conflict.status,409);
  const exported=await(await fetch(base+'/api/review/export')).json();assert.match(exported.text,/此处换图/);assert.match(exported.text,/镜头 T01/);
  const invalidJob=await fetch(base+'/api/review/jobs',{method:'POST',body:JSON.stringify({action:'render',shotIds:[999]})});assert.equal(invalidJob.status,400);
  const created=await(await fetch(base+'/api/review/jobs',{method:'POST',body:JSON.stringify({action:'compose'})})).json();assert.ok(created.job.id);
  let result;
  for(let i=0;i<100;i++){result=await(await fetch(base+'/api/review/jobs/'+created.job.id)).json();if(['done','failed'].includes(result.job.status))break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(result.job.status,'done');assert.equal(result.job.outputUrl,'/files/outputs/whole.mp4');
  const composed=await api.getProject(true);assert.equal(composed.fullVideoUrl,'/files/outputs/whole.mp4');assert.equal(composed.fullPreviewKind,'composed');
  const restarted=createReviewAPI({projectRoot:root,dataRoot,libRoot:root,json,engine});
  assert.equal((await restarted.getProject()).fullVideoUrl,'/files/outputs/whole.mp4');
  manifest.shots[0].fileSHA256='new-clip-hash';
  const outdated=await restarted.getProject(true);assert.equal(outdated.fullPreviewCurrent,false);assert.equal(outdated.fullVideoUrl,'/baseline.mp4');
  const range=await fetch(base+'/video',{headers:{range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 2-5/10');assert.equal(await range.text(),'2345');
  const invalid=await fetch(base+'/video',{headers:{range:'bytes=99-'}});assert.equal(invalid.status,416);
  const head=await fetch(base+'/video',{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
});
