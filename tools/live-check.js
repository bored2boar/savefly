const {createCanvas}=require('canvas');const fs=require('fs');
const POOL=process.argv[2], SECS=+(process.argv[3]||60), SHOT=process.argv[4];
let src=fs.readFileSync(require('path').join(__dirname,'..','src','savefly.html'),'utf8').split('<script>')[1].split('</script>')[0];
src=src.replace("  mode:      'demo',","  mode:      'provider',");
// a mode without shared state needs an explicit flag - otherwise
// the client falls back to demo and the check measures nothing
src=src.replace("  allowSolo: false","  allowSolo: true");
src=src.replace("  pool:      '',","  pool:      '"+POOL+"',");
src+=`\nglobalThis.__p=()=>({state:FEED.state,health:FEED.health(),stats:FEED.stats,
  step:S.step,gen:S.gen,px:S.px,pxAth:S.pxAth,silk:S.silk,debt:S.debt,
  kills:S.kills,bites:S.bites,sp:S.spiders.length,sh:S.shots.length,
  ck:S.ckHash,syncing,pending:[...FEED.byStep.values()].reduce((a,b)=>a+b.length,0),
  lastEv:FEED.lastEventTs,lag:SIMC.LAG_MS,gts:SIMC.GENESIS_TS});`;
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

let frames=0,done=false;
global.requestAnimationFrame=(fn)=>{if(!done)setTimeout(()=>{frames++;fn(Date.now());},16);};
eval(src);
const t0=Date.now();
const iv=setInterval(()=>{
  const p=global.__p();
  const el=((Date.now()-t0)/1000).toFixed(0).padStart(3);
  const dd=p.pxAth>0?(1-p.px/p.pxAth)*100:0;
  console.log(`${el}s  ${p.health.txt.padEnd(14)} polls=${String(p.stats.polls).padStart(2)} `+
    `trades=${String(p.stats.seen).padStart(4)} applied=${String(p.stats.applied).padStart(4)} `+
    `late=${String(p.stats.late).padStart(3)} queue=${String(p.pending).padStart(3)}  `+
    `step=${String(p.step).padStart(5)} sync=${String(p.syncing).padStart(5)}  `+
    `drawdown=${dd.toFixed(1)}% silk=${p.silk.toFixed(3)} k/b=${p.kills}/${p.bites} `+
    `spd=${p.sp} sht=${p.sh}`);
},5000);
setTimeout(()=>{
  clearInterval(iv);done=true;
  const p=global.__p();
  console.log('\n── summary ──');
  console.log('  price',p.px,' ATH',p.pxAth,' drawdown',((1-p.px/p.pxAth)*100).toFixed(2)+'%');
  console.log('  feed lag',p.lag,'ms   poll errors',p.stats.errs);
  console.log('  events: seen',p.stats.seen,'applied',p.stats.applied,'late',p.stats.late);
  console.log('  state hash',p.ck,' frames',frames);
  if(SHOT)fs.writeFileSync(SHOT,store['cv'].toBuffer('image/png'));
  process.exit(0);
},SECS*1000);
