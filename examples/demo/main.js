import {getScene,paintScene} from './scene.mjs';
const timeline = await (await fetch('./timeline.json')).json();
const configs = await Promise.all(timeline.map(shot=>fetch(`./shots/shot-${String(shot.id).padStart(3,'0')}.json`).then(r=>r.json())));
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
window.DUR=9;window.SHOTS=timeline;
window.render = async time => {
  const t=Math.max(0,Math.min(9,Number(time)||0));
  const shot=timeline.find(item=>t>=item.start&&t<item.end)||timeline.at(-1);
  paintScene(ctx,getScene(t,shot.id,configs[shot.id-1]));
  window.parent?.postMessage({type:'frame',time:t,shot,components:[]},location.origin);
};
// This example exposes source playback; component replacement requires a renderer-specific bridge.
window.COMPONENTS=()=>[];
window.PREVIEW_INFO=()=>({preview:false});
await window.render(0);
if(window.parent===window) {
  let origin=performance.now();
  const tick=now=>{window.render(((now-origin)/1000)%9);requestAnimationFrame(tick);};
  requestAnimationFrame(tick);
}
