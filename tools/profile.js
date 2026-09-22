#!/usr/bin/env node
/* Per-function render profiler.
   The previous version counted fillRect calls - after the switch to
   a Uint32 buffer there are none, so it printed 0.00 ms and NaN.
   Now it measures the drawing functions themselves and present().

   node tools/profile.js [scenario]
     idle  - calm (default)
     busy  - 12 spiders, 40 shots
     storm - night, downpour, lightning
*/
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
const SC=(process.argv[2]||'idle');
const FRAMES=+(process.env.FRAMES||200);

let src=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
const FN=['drawBack','drawWeb','drawSpider','drawShot','drawFly','drawLegs',
  'drawFx','drawRain','drawWeatherFront','drawVig','drawBolt','present'];
for(const n of FN)
  src=src.replace(new RegExp('\\nfunction '+n+'\\(','g'),'\nfunction '+n+'_raw(');
/* The wrapper must be declared with THE SAME NAME in the same
   scope, because the game calls present() directly, not through an object.
   The previous attempt hung wrappers on G and broke the calls. */
src+='\n'+FN.map(n=>`function ${n}(...a){\n`
  +`  if(typeof ${n}_raw!=='function')return;\n`
  +`  const s=process.hrtime.bigint();\n`
  +`  const r=${n}_raw.apply(null,a);\n`
  +`  G.__t['${n}']=(G.__t['${n}']||0n)+(process.hrtime.bigint()-s);\n`
  +`  G.__c['${n}']=(G.__c['${n}']||0)+1;\n`
  +`  return r;\n}`).join('\n');
src+=`\nG.__x={sy:()=>syncing,boot:()=>booting,sim:()=>S,
  setup:(k)=>{
    if(k==='busy'||k==='storm'){
      for(let i=0;i<12;i++)simSpawnSpider(2.0,70+i);
      for(let i=0;i<40;i++)simFireShot(.8,30+i);
    }
    if(k==='storm'){S.silk=.85;silk=.85;snapWeather();bolt=mkBolt();flash=1;}
  },
  top:()=>{if(S.spiders.length<4)for(let i=0;i<8;i++)simSpawnSpider(1.8,90+i);
    if(S.shots.length<20)for(let i=0;i<20;i++)simFireShot(.8,50+i);}};`;
src=src.replace(/globalThis\./g,'G.');

const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
function mkEl(){const c=createCanvas(1,1);
  c.addEventListener=()=>{};c.style={cssText:''};c.classList={add(){},remove(){}};
  c.textContent='';c.innerHTML='';c.className='';c.value=50;
  c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};
  c.appendChild=()=>{};c.requestFullscreen=()=>{};c.dataset={};return c;}
const store={};
const doc={getElementById(id){if(!store[id])store[id]=mkEl();return store[id];},
  createElement(){return mkEl();},addEventListener(){},body:mkEl(),
  fullscreenElement:null,exitFullscreen(){}};
const PERFOBJ={now:()=>performance.now(),memory:null,
  markResourceTiming:()=>{},mark:()=>{},measure:()=>{},timeOrigin:performance.timeOrigin};
const G={__t:{},__c:{}};
let n=0,armed=false,done=false,ts=[];
const raf=(cb)=>{if(done)return;setImmediate(()=>{
  n++;
  const X=G.__x;
  if(X&&!armed&&X.sy()===0&&!X.boot()&&n>15){
    armed=true;X.setup(SC);G.__t={};G.__c={};}
  if(armed&&n%25===0)X.top();
  if(armed)ts.push(process.hrtime.bigint());
  if(armed&&ts.length>FRAMES){done=true;report();return;}
  cb(Date.now());});};
function report(){
  let s=0n;for(let i=1;i<ts.length;i++)s+=ts[i]-ts[i-1];
  const nf=ts.length;
  const frame=Number(s)/1e6/(nf-1);
  console.log('scenario: '+SC+',  frames: '+nf);
  console.log('frame: '+frame.toFixed(3)+' ms  ->  '+(1000/frame).toFixed(0)+' fps');
  console.log();
  const e=Object.entries(G.__t).map(([k,v])=>[k,Number(v)/1e6/nf]);
  e.sort((a,b)=>b[1]-a[1]);
  let sum=0;
  console.log('  function           ms/frame  calls/frame     share');
  for(const [k,v] of e){
    sum+=v;
    if(v<0.005)continue;
    console.log('  '+k.padEnd(19)+v.toFixed(3).padStart(7)+
      (G.__c[k]/nf).toFixed(1).padStart(14)+
      (v/frame*100).toFixed(0).padStart(8)+'%');
  }
  console.log('  '+'total'.padEnd(19)+sum.toFixed(3).padStart(7)+
    ' '.repeat(14)+(sum/frame*100).toFixed(0).padStart(8)+'%');
  console.log();
  const S=G.__x.sim();
  console.log('state: spiders '+S.spiders.length+', shots '+S.shots.length+
    ', silk '+S.silk.toFixed(3));
  process.exit(0);
}
new Function('document','window','AudioContext','requestAnimationFrame','fetch','G','console','location','URLSearchParams','performance',src)
  (doc,{AudioContext:AC},AC,raf,fetch,G,console,{search:''},URLSearchParams,PERFOBJ);
setTimeout(()=>{if(!done){console.log('timeout: frame never became ready');process.exit(1);}},60000);
