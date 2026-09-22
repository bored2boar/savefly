#!/usr/bin/env node
/* New pixel layer vs canvas: colors and primitives must
   give the same result, otherwise the refactor changed the picture. */
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
let pass=0,fail=0;
const T=(n,ok,i)=>{if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(i?'  -> '+i:''));}};

// extract the pixel layer from the game
const js=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
const a=js.indexOf("const CVE=document.getElementById('cv')"), b=js.indexOf('function drawVig(');
const layer=js.slice(a,b);
const E={};
const W=64,H=48;
(new Function('document','exp',`
  const RW=${W},RH=${H};
  ${layer}
  exp.col=col;exp.pr=pr;exp.ps=ps;exp.pdisc=pdisc;exp.pring=pring;
  exp.pline=pline;exp.ppoly=ppoly;exp.pdith=pdith;exp.pdithL=pdithL;
  exp.pwash=pwash;exp.pnum=pnum;exp.blit=blit;exp.mkFB=mkFB;
  exp.fbPush=fbPush;exp.fbPop=fbPop;exp.fbClear=fbClear;
  exp.SCREEN=SCREEN;exp.C=C;exp.IMG=IMG;
`))({getElementById:()=>{const c=createCanvas(W,H);c.style={};return c;},
     createElement:()=>createCanvas(1,1)},E);

// ── colors ──
function rgbOf(v){return [v&255,(v>>8)&255,(v>>16)&255,(v>>>24)&255];}
T('hex #rrggbb',JSON.stringify(rgbOf(E.col('#3c2c54')))==='[60,44,84,255]',
  JSON.stringify(rgbOf(E.col('#3c2c54'))));
T('hex #rgb',JSON.stringify(rgbOf(E.col('#fff')))==='[255,255,255,255]');
T('rgb()',JSON.stringify(rgbOf(E.col('rgb(16,32,48)')))==='[16,32,48,255]');
{ // hsl vs canvas
  const c=createCanvas(1,1),x=c.getContext('2d');
  let bad=0,worst=0;
  for(const s of ['hsl(0,100%,50%)','hsl(120,50%,25%)','hsl(210,80%,60%)',
                  'hsl(45,0%,70%)','hsl(300,100%,90%)','hsl(190,66%,42%)']){
    x.fillStyle=s;x.clearRect(0,0,1,1);x.fillRect(0,0,1,1);
    const d=x.getImageData(0,0,1,1).data;
    const m=rgbOf(E.col(s));
    const e=Math.abs(d[0]-m[0])+Math.abs(d[1]-m[1])+Math.abs(d[2]-m[2]);
    if(e>3)bad++;
    if(e>worst)worst=e;
  }
  T('hsl() = canvas',bad===0,'diverging '+bad+', max error '+worst);
}
// ── primitives vs canvas ──
function refCanvas(draw){
  const c=createCanvas(W,H),x=c.getContext('2d');
  draw(x);
  return x.getImageData(0,0,W,H).data;
}
function mineFB(draw){
  const f=E.mkFB(W,H);
  const p=E.fbPush(f);
  draw();
  E.fbPop(p);
  return new Uint8Array(new Uint8Array(f.buf.buffer));
}
function cmp(name,refDraw,myDraw,tol){
  const A=refCanvas(refDraw),B=mineFB(myDraw);
  let d=0;
  for(let i=0;i<A.length;i+=4){
    if(A[i+3]===0&&B[i+3]===0)continue;
    if(Math.abs(A[i]-B[i])+Math.abs(A[i+1]-B[i+1])+Math.abs(A[i+2]-B[i+2])
      +Math.abs(A[i+3]-B[i+3])>6)d++;
  }
  T(name,d<=(tol||0),d+' pixels differ');
}
cmp('pr rectangle',
  (x)=>{x.fillStyle='#3c2c54';x.fillRect(5,7,20,11);},
  ()=>E.pr(5,7,20,11,'#3c2c54'));
cmp('pr out of bounds',
  (x)=>{x.fillStyle='#7ce060';x.fillRect(-6,-4,20,14);},
  ()=>E.pr(-6,-4,20,14,'#7ce060'));
cmp('pdisc',
  (x)=>{const ry=9;for(let dy=-ry;dy<=ry;dy++){const t=dy/9;if(t*t>=1)continue;
    const w=Math.round(13*Math.sqrt(1-t*t));if(w>0){x.fillStyle='#f04858';
      x.fillRect(Math.round(30)-w,Math.round(24)+dy,w*2+1,1);}}},
  ()=>E.pdisc(30,24,13,9,'#f04858'));
cmp('pline',
  (x)=>{x.fillStyle='#fffef4';
    let X=3,Y=5;const X1=55,Y1=40;const dx=Math.abs(X1-X),dy=Math.abs(Y1-Y);
    const sx=1,sy=1;let e=dx-dy;
    for(;;){x.fillRect(X,Y,1,1);if(X===X1&&Y===Y1)break;
      const e2=e*2;if(e2>-dy){e-=dy;X+=sx;}if(e2<dx){e+=dx;Y+=sy;}}},
  ()=>E.pline(3,5,55,40,'#fffef4'));
// ── dithering: density must match the level ──
{
  const f=E.mkFB(W,H);const p=E.fbPush(f);
  E.pdithL(0,0,W,H,'#ffffff',8);
  E.fbPop(p);
  let on=0;for(let i=0;i<f.buf.length;i++)if(f.buf[i]&0xff000000)on++;
  const frac=on/(W*H);
  T('dither level 8 = 50%',Math.abs(frac-0.5)<0.02,(frac*100).toFixed(1)+'%');
}
{
  const f=E.mkFB(W,H);const p=E.fbPush(f);
  E.pdith(0,0,W,H,'#ffffff',4,0);
  E.fbPop(p);
  let on=0;for(let i=0;i<f.buf.length;i++)if(f.buf[i]&0xff000000)on++;
  T('pdith step=4 = 25%',Math.abs(on/(W*H)-0.25)<0.03,(on/(W*H)*100).toFixed(1)+'%');
}
// ── pwash: blending ──
{
  const f=E.mkFB(W,H);const p=E.fbPush(f);
  E.pr(0,0,W,H,'#000000');
  E.pwash('#ffffff',0.5,0,0,W,H);
  E.fbPop(p);
  const v=f.buf[100];const r=v&255;
  T('pwash 50% black+white ~128',Math.abs(r-128)<=4,'r='+r);
}
// ── blit: transparent pixels do not overwrite ──
{
  const src=E.mkFB(8,8);
  let p=E.fbPush(src);E.pr(2,2,4,4,'#7ce060');E.fbPop(p);
  const dst=E.mkFB(W,H);
  p=E.fbPush(dst);E.pr(0,0,W,H,'#241a34');E.blit(src,10,10);E.fbPop(p);
  const inside=dst.buf[12*W+12]&255, outside=dst.buf[10*W+10]&255;
  T('blit skips transparent',inside===0x7c&&outside===0x24,
    'inside=0x'+inside.toString(16)+' outside=0x'+outside.toString(16));
}
// ── full color path: sky bands must exactly equal skyRamp ──
{
  const js2=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
    .split('<script>')[1].split('</script>')[0];
  const sa=js2.indexOf('const SKY_DAY='), sb=js2.indexOf('let wx=0,');
  const F={};
  (new Function('exp',`
    function cl(v,x,y){return v<x?x:(v>y?y:v);}
    ${js2.slice(sa,sb)}
    exp.skyRamp=skyRamp;exp.mixc=mixc;`))(F);
  let bad=0,worst='';
  for(const w of [0.0,0.15,0.34,0.5,0.72,0.95]){
    const R=F.skyRamp(w);
    for(const cstr of R){
      const v=E.col(cstr);
      const m=cstr.match(/-?[\d.]+/g).map(Number);
      const got=[v&255,(v>>8)&255,(v>>16)&255];
      const e=Math.abs(m[0]-got[0])+Math.abs(m[1]-got[1])+Math.abs(m[2]-got[2]);
      if(e>0){bad++;if(!worst)worst=cstr+' -> '+got.join(',');}
    }
  }
  T('skyRamp -> col() lossless',bad===0,bad+' diverging, e.g. '+worst);
}
// ── shadeSet (hsl) via col() ──
{
  const js2=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
    .split('<script>')[1].split('</script>')[0];
  const i=js2.indexOf('function shadeSet(');
  const j=js2.indexOf('\nconst FKEYS');
  const F={};
  (new Function('exp',`
    function cl(v,x,y){return v<x?x:(v>y?y:v);}
    function hsl(h,s,l){return'hsl('+Math.round(h)+','+Math.round(cl(s,0,100))+'%,'+Math.round(cl(l,0,100))+'%)';}
    ${js2.slice(i,j)}
    exp.shadeSet=shadeSet;exp.hsl=hsl;`))(F);
  const c=createCanvas(1,1),x=c.getContext('2d');
  let bad=0,worst=0;
  for(const [h,s,l] of [[150,60,55],[20,80,40],[280,35,70],[0,0,20]]){
    const set=F.shadeSet(h,s,l);
    for(const k in set){
      const str=set[k];
      if(typeof str!=='string'||!str.startsWith('hsl'))continue;
      x.clearRect(0,0,1,1);x.fillStyle=str;x.fillRect(0,0,1,1);
      const d=x.getImageData(0,0,1,1).data;
      const v=E.col(str);
      const e=Math.abs(d[0]-(v&255))+Math.abs(d[1]-((v>>8)&255))+Math.abs(d[2]-((v>>16)&255));
      if(e>3)bad++;
      if(e>worst)worst=e;
    }
  }
  T('shadeSet(hsl) = canvas',bad===0,bad+' diverging, max error '+worst);
}
console.log();
console.log(`RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
