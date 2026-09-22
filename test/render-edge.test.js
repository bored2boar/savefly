#!/usr/bin/env node
/* Edge cases of the render layer and the event queue - things the simulation
   tests do not see because they do not affect state, but the user does see. */
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
let pass=0,fail=0;
function T(n,ok,info){if(ok){pass++;console.log('  PASS  '+n);}
  else{fail++;console.log('  FAIL  '+n+(info?'  -> '+info:''));}}

function boot(patch){
  let src=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
    .split('<script>')[1].split('</script>')[0];
  src+=`\nG.__x={sim:()=>S,outq:()=>OUTQ,drop:()=>(typeof OUTDROP!=='undefined'?OUTDROP:-1),
    fx:()=>fx,legs:()=>legs,spoke:()=>SPOKE,buzz:()=>webBuzz,
    wx:()=>wx,wxT:()=>wxT,sy:()=>syncing,boot:()=>booting,
    logN:()=>logN,gen:()=>gen,dnaName:()=>DNA&&DNA.name,
    emitN:(n)=>{for(let i=0;i<n;i++)emit('kill',{x:160,y:96,spoke:i%12,size:1,kills:i});},
    spider:(n,s)=>{for(let i=0;i<n;i++)simSpawnSpider(s,70+i);},
    kill:(n)=>{for(let i=0;i<n;i++)emit('kill',{x:100+i,y:90,spoke:i%12,size:2,kills:i});},
    setSilk:(v)=>{S.silk=v;silk=v;},
    snapWeather:()=>snapWeather(),
    updW:(dt)=>updWeather(dt),
    getwx:()=>[wx,wxT],
    restore:(o)=>{try{S=simRestore(o);return 'ok';}catch(e){return 'throw: '+e.message;}},
    ckValid:(o,m)=>ckValid(o,m),
    drain:()=>drainOUT(false),
    emitHatch:(sd)=>emit('hatch',{gen:S.gen,seed:sd}),
    drainNames:(out)=>{const q=OUTQ.slice();OUTQ.length=0;
      for(const e of q)if(e.t==='hatch'){applyGen(e.seed);out.push(DNA.name);}}};`;
  src=src.replace(/globalThis\./g,'G.');
  if(patch)src=patch(src);
  const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
  const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
  const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
  function mkEl(){const c=createCanvas(1,1);c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};c.textContent='';c.innerHTML='';c.className='';c.value=50;c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};c.appendChild=()=>{};c.requestFullscreen=()=>{};return c}
  const store={};
  const doc={getElementById(id){if(!store[id])store[id]=mkEl();return store[id]},createElement(){return mkEl()},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
  const G={};let done=false,frames=0;
  const raf=(cb)=>{if(!done)setTimeout(()=>{frames++;cb(Date.now());},4)};
  new Function('document','window','AudioContext','requestAnimationFrame','fetch','G',src)
    (doc,{AudioContext:AC},AC,raf,fetch,G);
  return {G,stop:()=>{done=true;},frames:()=>frames};
}
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  console.log();
  // 1. event queue overflow
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    X.emitN(2000);
    const q=X.outq().length,dr=X.drop();
    X.drain();
    T('event queue is capped',q<=400,'length='+q);
    T('dropped events are counted',dr>=0,'OUTDROP='+(dr<0?'no counter':dr));
    stop();
  }
  // 2. render arrays are capped
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    for(let r=0;r<12;r++){X.kill(40);X.drain();}
    await wait(120);
    T('leg debris is capped',X.legs().length<=400,'legs='+X.legs().length);
    T('particles are capped',X.fx().length<=600,'fx='+X.fx().length);
    stop();
  }
  // 3. spoke vibration within bounds
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    for(let r=0;r<6;r++){X.spider(12,2.5);X.drain();}
    await wait(60);
    const mx=Math.max(...X.spoke().map(s=>s.vib));
    T('spoke vibration <= 1',mx<=1.0001,'max='+mx.toFixed(3));
    T('webBuzz <= 1',X.buzz()<=1.0001,'buzz='+X.buzz().toFixed(3));
    stop();
  }
  // 4. weather at startup must match the state, not ramp up over a minute
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    // 1) state snapshot with high silk -> weather must apply immediately
    X.setSilk(0.85);
    X.snapWeather();
    const d0=Math.abs(X.wx()-X.wxT());
    T('snapWeather sets weather immediately',d0<0.02,
      'wx='+X.wx().toFixed(3)+' target='+X.wxT().toFixed(3));
    // 2) in normal play the transition must be smooth, not a jump.
    //    We drive weather steps directly: otherwise the test depends on
    //    whether snapWeather fired from a sync or a re-anchor.
    X.setSilk(0.10);
    const before=X.getwx()[0];
    for(let i=0;i<10;i++)X.updW(1);
    const [w1,t1]=X.getwx();
    const moved=Math.abs(w1-before),gap=Math.abs(before-t1);
    T('weather changes smoothly in play',
      moved>0.0001&&moved<gap*0.5,
      `moved ${moved.toFixed(4)} of a ${gap.toFixed(4)} gap in 10 steps`);
    stop();
  }
  // 5. snapshot validation: entities with corrupted fields
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    const bad={step:10,gen:1,px:0.03,pxAth:0.03,silk:0.1,debt:0,kills:0,bites:0,
      spiders:[[1,99,0.5,0.5,1,1,0.001,0,0,0,0]],shots:[]};
    const why=X.ckValid(bad,null);
    T('snapshot with spoke=99 is rejected',!!why,'ckValid -> '+why);
    const bad2={step:10,gen:1,px:0.03,pxAth:0.03,silk:0.1,debt:0,kills:0,bites:0,
      spiders:[[1,3,NaN,0.5,1,1,0.001,0,0,0,0]],shots:[]};
    T('snapshot with NaN in a spider is rejected',!!X.ckValid(bad2,null),'ckValid -> '+X.ckValid(bad2,null));
    stop();
  }
  // 6. several generations in one frame: the log must name different flies
  {
    const {G,stop}=boot();
    await wait(900);
    const X=G.__x;
    const names=[];
    const seeds=[111,222,333];
    for(const sd of seeds){
      X.sim().seed=sd;
      X.emitHatch(sd);
    }
    X.drainNames(names);
    const uniq=new Set(names);
    T('several hatches -> different names in the log',uniq.size===seeds.length,
      'names: '+names.join(', '));
    stop();
  }
  console.log();
  console.log(`RESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail?1:0);
})();
