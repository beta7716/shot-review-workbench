import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createReviewStore, normalizeNote, formatReviewExport } from '../lib/review-store.mjs';
import { parseByteRange } from '../lib/http-files.mjs';

const project = { id:'test-film', title:'测试片', revision:'baseline-1', width:1920,height:1080,fps:30,duration:5,
  shots:[{id:1,title:'开头',start:0,end:2,startFrame:0,endFrame:60},{id:2,title:'结果',start:2,end:5,startFrame:60,endFrame:150}] };
const note = extra => ({id:'note-1',scope:'shot',shotId:2,time:2.5,endTime:3,region:{x:.1,y:.2,w:.3,h:.4},text:'替换这里的图片，保留字幕',attachments:[],status:'open',...extra});

test('notes reject out-of-shot times, bad regions and file traversal', () => {
  assert.equal(normalizeNote(note(),project).shotId,2);
  assert.throws(()=>normalizeNote(note({time:1}),project),/超出/);
  assert.throws(()=>normalizeNote(note({region:{x:.9,y:0,w:.3,h:.2}}),project),/超出/);
  assert.throws(()=>normalizeNote(note({attachments:[{name:'bad',path:'uploads/../secret.txt'}]}),project),/路径/);
  assert.throws(()=>normalizeNote(note({text:'  '}),project),/内容/);
});

test('store persists edits and attachments across reloads and refuses a stale write', async t => {
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'review-store-'));
  t.after(()=>fs.rm(dataRoot,{recursive:true,force:true}));
  await fs.mkdir(path.join(dataRoot,'uploads'));await fs.writeFile(path.join(dataRoot,'uploads','test.png'),'fixture');
  const store=createReviewStore({dataRoot,getProject:async()=>project});
  const initial=await store.read();assert.equal(initial.revision,0);
  const saved=await store.save({...initial,notes:[note({attachments:[{name:'参考图.png',path:'uploads/test.png',type:'image/png'}]})]});
  assert.equal(saved.revision,1);
  const fresh=createReviewStore({dataRoot,getProject:async()=>project});
  assert.equal((await fresh.read()).notes[0].attachments[0].url,'/files/uploads/test.png');
  await assert.rejects(store.save({...initial,notes:[]}),error=>error.status===409);
  await store.save({...saved,notes:[note({text:'更新了批注',status:'done'})]});
  assert.equal((await store.read()).notes[0].status,'done');
});

test('export preserves global and shot notes, coordinates and real local attachment paths', () => {
  const text=formatReviewExport(project,{projectRevision:'baseline-1',notes:[note({attachments:[{name:'参考.png',path:'uploads/ref.png',url:'/files/uploads/ref.png'}]}),note({id:'global',scope:'global',shotId:null,time:0,endTime:5,region:null,text:'全片建议',status:'done'})]}, {dataRoot:path.resolve('data'),projectRoot:path.resolve('film')});
  assert.match(text,/镜头 T02/);assert.match(text,/全片建议/);assert.match(text,/已完成/);
  assert.match(text,/192,216,576,432/);assert.ok(text.includes(path.resolve('data','uploads/ref.png')));
  assert.match(text,/00:02.500/);assert.match(text,/保留其他内容/);
});

test('video byte ranges support suffix/open ended requests and reject invalid ranges', () => {
  assert.deepEqual(parseByteRange('bytes=20-39',100),{start:20,end:39});
  assert.deepEqual(parseByteRange('bytes=80-',100),{start:80,end:99});
  assert.deepEqual(parseByteRange('bytes=-10',100),{start:90,end:99});
  assert.deepEqual(parseByteRange('bytes=90-200',100),{start:90,end:99});
  for(const range of ['bytes=100-','bytes=5-3','bytes=0-1,3-4','bytes=-0','bytes=-'])assert.equal(parseByteRange(range,100),false);
});
