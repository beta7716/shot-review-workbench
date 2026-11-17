// Original example art: rectangles and a tiny bitmap alphabet, no external assets.
const FONT = {
  A:['01110','10001','10001','11111','10001','10001','10001'],
  D:['11110','10001','10001','10001','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'],
  H:['10001','10001','10001','11111','10001','10001','10001'],
  L:['10000','10000','10000','10000','10000','10000','11111'],
  N:['10001','11001','11001','10101','10011','10011','10001'],
  O:['01110','10001','10001','10001','10001','10001','01110'],
  R:['11110','10001','10001','11110','10100','10010','10001'],
  S:['01111','10000','10000','01110','00001','00001','11110'],
  T:['11111','00100','00100','00100','00100','00100','00100'],
  U:['10001','10001','10001','10001','10001','10001','01110'],
  Y:['10001','10001','01010','00100','00100','00100','00100'],
  C:['01111','10000','10000','10000','10000','10000','01111'],
  '1':['00100','01100','00100','00100','00100','00100','01110'],
  '2':['01110','10001','00001','00010','00100','01000','11111'],
  '3':['11110','00001','00001','01110','00001','00001','11110']
};
const BACKGROUND = '#101824', PANEL = '#1e2d42', INK = '#e5edf7';
export function getScene(time, shotId, config = {}) {
  const id = Math.max(1, Math.min(3, Number(shotId))), local = Math.max(0, Math.min(3, time - (id - 1) * 3));
  const p = Math.min(1, local / 2.6), accent = config.accent || '#5cc8ff';
  const rectangles = [{x:0,y:0,w:1920,h:1080,color:BACKGROUND}];
  const rect = (x,y,w,h,color) => rectangles.push({x:Math.round(x),y:Math.round(y),w:Math.round(w),h:Math.round(h),color});
  const label = (text,x,y,size,color) => {
    for (const [index,char] of [...text.toUpperCase()].entries()) {
      const pixels = FONT[char];
      if (!pixels) continue;
      for (let row=0;row<7;row++) for(let column=0;column<5;column++) if(pixels[row][column]==='1') rect(x+(index*6+column)*size,y+row*size,size,size,color);
    }
  };
  rect(100,100,80,10,accent);
  label(`SHOT ${id}`,100,145,7,accent);
  label(config.title || ['SELECT A SHOT','ADD YOUR NOTE','RENDER ONE SHOT'][id-1],100,260,10,INK);
  if(id===1) {
    for(let i=0;i<3;i++) { rect(150+i*540,440,460,330,PANEL); rect(185+i*540,475,390,180,i===1?accent:'#31445e'); }
    rect(660+70*p,415,460,10,accent);rect(660+70*p,770,460,10,accent);
    rect(660+70*p,415,10,365,accent);rect(1110+70*p,415,10,365,accent);
  } else if(id===2) {
    rect(150,420,900,410,PANEL);rect(190,460,820,220,'#31445e');
    const noteX=1180-100*p;rect(noteX,460,600,310,accent);
    for(let i=0;i<3;i++)rect(noteX+45,510+i*65,Math.min(490,(p*3-i)*490),20,'#5a4518');
    rect(190,730,190,45,accent);
  } else {
    for(let i=0;i<3;i++) { rect(170+i*550,460,460,290,PANEL);rect(195+i*550,485,410,210,i===1?accent:'#31445e'); }
    rect(170,830,1560,24,'#31445e');rect(170,830,1560*p,24,accent);
    label('2',915,555,12,'#101824');
  }
  return {rectangles, shotId:id, localTime:local, background:BACKGROUND};
}

export function paintScene(ctx, scene) {
  for(const r of scene.rectangles) { if(r.w<=0||r.h<=0)continue;ctx.fillStyle=r.color;ctx.fillRect(r.x,r.y,r.w,r.h); }
}
