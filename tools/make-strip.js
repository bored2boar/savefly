#!/usr/bin/env node
/* Sprite strip from the engine for the landing animation.
   The frames are real: the scene is set once, then the simulation runs and
   every Nth frame is captured. The strip is joined horizontally and
   animated in CSS via steps() - the same way game sprites
   are animated, with no smooth transitions.

   Scale 1: the browser upscales it via image-rendering:pixelated,
   so the strip stays small.

   node tools/make-strip.js [silk] [frames] [step] [out.png]
*/
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
const SILK=+(process.argv[2]||0.30);
const N=+(process.argv[3]||16);
const EVERY=+(process.argv[4]||6);
const OUT=process.argv[5]||path.join(__dirname,'..','src','strip.png');
const CW=300,CH=157,CX=10,CY=14;

let src=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
src+=`\nG.__x={sy:()=>syncing,boot:()=>booting,
  set:(v)=>{S.silk=v;silk=v;snapWeather();
    S.spiders.length=0;S.shots.length=0;
    simSpawnSpider(1.9,4);simSpawnSpider(1.3,9);
    for(let i=0;i<10;i++)simFireShot(.8,16+i);},
  top:()=>{if(S.spiders.filter(s=>!s.dying).length<2)simSpawnSpider(1.7,(S.step%12)|0);
    if(S.shots.length<6)for(let i=0;i<6;i++)simFireShot(.8,20+i);},
  sim:()=>S};`;
src=src.replace(/globalThis\./g,'G.');
const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
let screen=null;
function mkEl(id){const c=createCanvas(1,1);
  c.addEventListener=()=>{};c.style={cssText:''};c.classList={add(){},remove(){}};
  c.textContent='';c.innerHTML='';c.className='';c.value=50;
  c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};
  c.appendChild=()=>{};c.requestFullscreen=()=>{};c.dataset={};
  if(id==='cv')screen=c;return c;}
const store={};
const doc={getElementById(id){if(!store[id])store[id]=mkEl(id);return store[id]},
  createElement(){return mkEl()},addEventListener(){},body:mkEl(),
  fullscreenElement:null,exitFullscreen(){}};
const PERFOBJ={now:()=>performance.now(),memory:null,markResourceTiming:()=>{},
  mark:()=>{},measure:()=>{},timeOrigin:performance.timeOrigin};

const strip=createCanvas(CW*N,CH);
const sg=strip.getContext('2d');
sg.imageSmoothingEnabled=false;
let n=0,armed=0,shot=0,done=false;
const WARM=+(process.env.WARM||40);   // warm-up frames after set()
const G={};
const raf=(cb)=>{if(done)return;setImmediate(()=>{
  n++;
  const X=G.__x;
  if(X&&!armed&&X.sy()===0&&!X.boot()&&n>25){armed=n;X.set(SILK);}
  if(armed&&n%14===0)X.top();
  // the hatch flash does not fade instantly - capture after warm-up
  if(armed&&n>armed+WARM&&n%EVERY===0&&shot<N){
    sg.drawImage(screen,CX,CY,CW,CH,shot*CW,0,CW,CH);
    shot++;
    if(shot>=N){done=true;finish();return;}
  }
  cb(1789000000000+n*16);});};
function finish(){
  fs.writeFileSync(OUT,strip.toBuffer('image/png'));
  const kb=(fs.statSync(OUT).size/1024).toFixed(0);
  console.log('strip: '+OUT);
  console.log('  frames '+N+' at '+CW+'x'+CH+'  ->  '+(CW*N)+'x'+CH+'  '+kb+' KB');
  console.log('  silk '+SILK+', every '+EVERY+'th frame');
  process.exit(0);
}
new Function('document','window','AudioContext','requestAnimationFrame','fetch','G','console','location','URLSearchParams','performance',src)
  (doc,{AudioContext:AC},AC,raf,fetch,G,{error(){},warn(){},log(){}},
   {search:''},URLSearchParams,PERFOBJ);
setTimeout(()=>{if(!done){console.error('did not collect frames: '+shot);process.exit(1);}},40000);
