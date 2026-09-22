#!/usr/bin/env node
/* One client in its own process. Prints JSON with its state. */
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const FSTEP=+(process.env.FSTEP||16);
const RUNMS=+(process.env.RUNMS||25000);
const URL=process.env.DATA_URL||'http://localhost:8099/data/';
const MODE=process.env.MODE||'csv';

let src=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
src=src.replace("  mode:      'demo',","  mode:      '"+MODE+"',");
src=src.replace("  dataUrl:   'data/',","  dataUrl:   '"+URL+"',");
src=src.replace("  pollMs:    4000,","  pollMs:    "+(process.env.POLL||3000)+",");
src+=`\nglobalThis.__p=()=>({ck:S.ckHash,ckStep:S.ckStep,step:S.step,gen:S.gen,
  px:S.px,pxAth:S.pxAth,silk:S.silk,debt:S.debt,kills:S.kills,bites:S.bites,
  ev:S.evCount,ckLog:S.ckLog,stats:FEED.stats,sy:syncing,boot:booting,shared:FEED.shared,
  lag:SIMC.LAG_MS,gts:SIMC.GENESIS_TS,hash:simHash()});`;

const param=()=>({value:0,setValueAtTime(){return this;},
  linearRampToValueAtTime(){return this;},
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
  createElement(){return mkEl();},addEventListener(){},
  fullscreenElement:null,exitFullscreen(){}};
global.window={AudioContext:global.AudioContext};
let frames=0,done=false;
global.requestAnimationFrame=(cb)=>{
  if(done)return;
  setTimeout(()=>{frames++;cb(Date.now());},Math.max(1,FSTEP));
};
try{eval(src);}catch(e){console.log(JSON.stringify({err:e.message}));process.exit(1);}
setTimeout(()=>{
  done=true;
  const p=global.__p?global.__p():null;
  console.log(JSON.stringify(p?Object.assign({frames},p):{err:'no state'}));
  process.exit(0);
},RUNMS);
