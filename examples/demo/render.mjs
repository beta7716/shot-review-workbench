import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {getScene} from './scene.mjs';

const rgb = hex => Buffer.from([1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)));
export function rasterizeScene(scene,width=1920,height=1080) {
  const pixels=Buffer.allocUnsafe(width*height*3);
  for (const r of scene.rectangles) {
    if(r.w<=0||r.h<=0)continue;
    const x=Math.max(0,Math.min(width,r.x)), y=Math.max(0,Math.min(height,r.y));
    const right=Math.max(x,Math.min(width,r.x+r.w)),bottom=Math.max(y,Math.min(height,r.y+r.h));
    const color=rgb(r.color);
    if(x===0&&y===0&&right===width&&bottom===height)pixels.fill(color);
    else for(let row=y;row<bottom;row++)pixels.fill(color,(row*width+x)*3,(row*width+right)*3);
  }
  return pixels;
}

export async function renderShot({projectRoot,shot,outputPath,fps=30,width=1920,height=1080,encodingArgs,onProgress}) {
  if(width!==1920||height!==1080||fps!==30)throw new Error('The demo renderer requires 1920x1080 at 30 fps');
  if(!Array.isArray(encodingArgs)||!encodingArgs.length)throw new Error('The segment engine must provide encodingArgs');
  const config=JSON.parse(await readFile(path.join(projectRoot,'shots',`shot-${String(shot.id).padStart(3,'0')}.json`),'utf8'));
  const encoder=spawn('ffmpeg',['-y','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgb24','-video_size',`${width}x${height}`,'-framerate',String(fps),'-i','-','-an',
    '-vf','scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',...encodingArgs,'-frames:v',String(shot.frameCount),'-video_track_timescale','30000','-movflags','+faststart',outputPath],{windowsHide:true,stdio:['pipe','ignore','pipe']});
  let errors='';encoder.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-12000);});encoder.stdin.on('error',()=>{});
  const closed=new Promise((resolve,reject)=>{encoder.once('error',reject);encoder.once('close',code=>code===0?resolve():reject(new Error(`Demo encoder failed (${code}): ${errors}`)));});
  closed.catch(()=>{});
  try {
    for(let frame=shot.startFrame;frame<shot.endFrame;frame++) {
      const pixels=rasterizeScene(getScene(frame/fps,shot.id,config),width,height);
      await new Promise((resolve,reject)=>encoder.stdin.write(pixels,error=>error?reject(error):resolve()));
      if((frame-shot.startFrame)%15===0)onProgress?.({progress:(frame-shot.startFrame+1)/shot.frameCount,message:`Demo shot ${shot.id}`});
    }
    encoder.stdin.end();await closed;
  } catch(error) {encoder.kill();await closed.catch(()=>{});throw error;}
}
