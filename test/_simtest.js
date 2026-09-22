const {createCanvas}=require('canvas');const fs=require('fs');
const FRAMES=+process.argv[3]||1500;
const FSTEP=+process.env.FSTEP||16.7;
const CLOCK=+process.argv[4]||Date.now();
let src=fs.readFileSync(process.argv[2],'utf8');
src+='\nglobalThis.__jump=(t)=>{simCatchUp(t,0);OUTQ.length=0;return globalThis.__probe();};'
+'\nglobalThis.__probe=()=>({syncF:syncFrames,syncMs:Math.round(syncMs),ck:S.ckHash,ckStep:S.ckStep,step:S.step,gen:S.gen,hash:simHash(),mc:S.mc,ath:S.ath,silk:S.silk,kills:S.kills,bites:S.bites,ev:S.evCount,local:S.local,sp:S.spiders.length,sh:S.shots.length,syncing,syncTotal,seed:S.seed});';
const param=()=>({value:0,setValueAtTime(){return this;},linearRampToValueAtTime(){return this;},
  exponentialRampToValueAtTime(){return this;},setTargetAtTime(){return this;}});
const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,
  frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
global.AudioContext=function(){return{currentTime:0,sampleRate:48000,state:'running',
  destination:anode(),resume(){},createOscillator:anode,createGain:anode,
  createBiquadFilter:anode,createBufferSource:anode,
  createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})};};
function mkEl(){const c=createCanvas(1,1);
  c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};
  c.textContent='';c.innerHTML='';c.className='';c.value=50;
  c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};
  c.appendChild=()=>{};c.requestFullscreen=()=>{};return c;}
const store={};
global.document={getElementById(id){if(!store[id])store[id]=mkEl();return store[id];},
  createElement(){return mkEl();},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
global.window={AudioContext:global.AudioContext};
let vt=CLOCK;
// simulation time is mocked, profiler time is real
const hr=()=>Number(process.hrtime.bigint())/1e6;
global.performance={now:hr};
Date.now=()=>vt;
const ENDT=CLOCK+(+process.env.RUNMS||12000);
let frames=0,done=false;
global.requestAnimationFrame=(fn)=>{
  vt+=FSTEP;
  try{if(process.env.SPAWNAT&&frames===+process.env.SPAWNAT)for(let i=0;i<5;i++)spawnSpider(0.6+i*0.5);}catch(e){}
  if(vt<ENDT&&frames++<400000)setImmediate(()=>fn(vt));
  else if(!done){done=true;
    const JT=+process.env.JUMPTO||0;
    const p=JT?global.__jump(JT):global.__probe();
    console.log(JSON.stringify(p));
    if(process.argv[5])fs.writeFileSync(process.argv[5],store['cv'].toBuffer('image/png'));}};
try{eval(src);}catch(e){console.log('RUNTIME: '+e.message);process.exit(1);}
setTimeout(()=>{if(!done)console.log('TIMEOUT at '+frames);},40000);
