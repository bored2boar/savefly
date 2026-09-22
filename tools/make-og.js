#!/usr/bin/env node
/* Share image. Rendered by the same engine as the game,
   so it is a real frame, not a drawn mockup.
   The state is set by arguments, so you can capture both a healthy fly
   and a wrapped one.

   node tools/make-og.js [silk] [out.png]
*/
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
const SILK=+(process.argv[2]||0.55);
const OUT=process.argv[3]||path.join(__dirname,'..','src','og.png');
const W=1200,H=630;

let src=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
src=src.replace(/Math\.random\(\)/g,'0.5');
src+=`\nG.__x={sy:()=>syncing,boot:()=>booting,cv:()=>CVE,
  set:(v)=>{S.silk=v;silk=v;snapWeather();
    S.spiders.length=0;S.shots.length=0;
    simSpawnSpider(1.7,5);simSpawnSpider(1.1,9);
    for(let i=0;i<10;i++)simFireShot(.8,20+i);
    for(const s of SPOKE)s.vib=0;flashT=0;shake=0;
    fx.length=0;legs.length=0;}};`;
src=src.replace(/globalThis\./g,'G.');
const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
let screen=null;
function mkEl(id){
  const c=createCanvas(1,1);
  c.addEventListener=()=>{};c.style={cssText:''};
  c.classList={add(){},remove(){}};
  c.textContent='';c.innerHTML='';c.className='';c.value=50;
  c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};
  c.appendChild=()=>{};c.requestFullscreen=()=>{};c.dataset={};
  if(id==='cv')screen=c;
  return c;
}
const store={};
const doc={getElementById(id){if(!store[id])store[id]=mkEl(id);return store[id];},
  createElement(){return mkEl();},addEventListener(){},body:mkEl(),
  fullscreenElement:null,exitFullscreen(){}};
const PERFOBJ={now:()=>performance.now(),memory:null,
  markResourceTiming:()=>{},mark:()=>{},measure:()=>{},timeOrigin:performance.timeOrigin};
let n=0,done=false,armed=0;
const G={};
const raf=(cb)=>{if(done)return;setImmediate(()=>{n++;
  const X=G.__x;
  if(X&&X.sy()===0&&!X.boot()&&n>25){armed++;X.set(SILK);}
  cb(1789000000000+n*16);});};
new Function('document','window','AudioContext','requestAnimationFrame','fetch','G','console','location','URLSearchParams','performance',src)
  (doc,{AudioContext:AC},AC,raf,fetch,G,{error(){},warn(){},log(){}},
   {search:''},URLSearchParams,PERFOBJ);
setTimeout(()=>{
  done=true;
  if(!armed||!screen){console.error('frame not ready');process.exit(1);}
  // upscale without smoothing: a pixel stays a pixel
  /* The 320x224 frame has a 1.43 ratio, og has 1.90. Fitting it
     at an integer scale gives x2 and lots of dark margins. So we cut
     a 300x157 band around the web from the frame and use x4 scale:
     1200x628, and the pixels stay crisp. */
  const out=createCanvas(W,H),g=out.getContext('2d');
  g.imageSmoothingEnabled=false;
  const cw=300,ch=157,k=4;
  const cx=Math.round((320-cw)/2), cy=14;   // slightly above center: the fly is at 96
  g.fillStyle='#0a0612';g.fillRect(0,0,W,H);
  g.drawImage(screen,cx,cy,cw,ch,(W-cw*k)/2,(H-ch*k)/2,cw*k,ch*k);
  // caption
  g.imageSmoothingEnabled=true;
  g.font='700 34px ui-monospace, monospace';
  g.textAlign='center';g.textBaseline='alphabetic';
  // the band must be solid: the caption was unreadable over the web
  const bh=92;
  const grad=g.createLinearGradient(0,H-bh,0,H);
  grad.addColorStop(0,'rgba(10,6,18,0)');
  grad.addColorStop(0.35,'rgba(10,6,18,.92)');
  grad.addColorStop(1,'rgba(10,6,18,.98)');
  g.fillStyle=grad;
  g.fillRect(0,H-bh,W,bh);
  g.fillStyle='#8cf0cc';
  g.fillText('SAVEFLY', W/2, H-34);
  g.font='500 17px ui-monospace, monospace';
  g.fillStyle='#9484ac';
  g.fillText('sells spawn spiders  ·  buys shoot them down  ·  state derived from the chain',
    W/2, H-12);
  fs.writeFileSync(OUT,out.toBuffer('image/png'));
  const kb=(fs.statSync(OUT).size/1024).toFixed(0);
  console.log('wrote '+OUT+'  '+W+'x'+H+'  '+kb+' KB  (silk '+SILK+', scale x'+k+')');
  process.exit(0);
},6000);
