const {createCanvas}=require('canvas');const fs=require('fs');
// provider simulator: serves real trades the way a real
// indexer does - in batches, with delay and repeats
const REAL=JSON.parse(fs.readFileSync(process.env.FIX||require('path').join(__dirname,'fixtures','real-pools.json'),'utf8')).trades['PAID[trend]'];
const DELAY=+(process.env.DELAY||20000);   // indexing delay
const POLL=+(process.env.POLL||4000);
const trades=REAL.slice().sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
const span=Date.parse(trades[trades.length-1].ts)-Date.parse(trades[0].ts);
const T0=Date.parse(trades[0].ts);
let VT=DELAY+180000;   // start once the provider already has history
function providerNow(){return T0+VT;}
function providerTrades(){
  // serves the last 300 trades, indexed with a delay
  const cutoff=providerNow()-DELAY;
  const vis=trades.filter(t=>Date.parse(t.ts)<=cutoff);
  return vis.slice(-300).reverse().map(t=>({attributes:{
    block_timestamp:t.ts,kind:t.side>0?'buy':'sell',
    from_token_amount:String(t.side>0?t.sol:1),
    to_token_amount:String(t.side>0?1:t.sol),
    price_to_in_usd:String(t.side>0?t.px:0),
    price_from_in_usd:String(t.side>0?0:t.px),
    block_number:t.blk,tx_hash:t.sig}}));
}
global.fetch=async(u)=>{
  if(String(u).includes('/ohlcv/')){
    const hi=Math.max(...trades.map(t=>t.px));
    return{ok:true,json:async()=>({data:{attributes:{ohlcv_list:[
      [T0/1000,hi,hi,hi,trades[0].px,0]]}}})};
  }
  return{ok:true,json:async()=>({data:providerTrades()})};
};
let src=fs.readFileSync(require('path').join(__dirname,'..','src','savefly.html'),'utf8').split('<script>')[1].split('</script>')[0];
src=src.replace("  mode:      'demo',","  mode:      'provider',");
src=src.replace("  allowSolo: false","  allowSolo: true");
src=src.replace("  pool:      '',","  pool:      'TEST',");
src=src.replace("  pollMs:    4000,","  pollMs:    "+POLL+",");
src+=`\nglobalThis.__p=()=>({stats:FEED.stats,step:S.step,silk:S.silk,px:S.px,pxAth:S.pxAth,
  kills:S.kills,bites:S.bites,ck:S.ckHash,sy:syncing,boot:booting,
  q:[...FEED.byStep.values()].reduce((a,b)=>a+b.length,0),lag:SIMC.LAG_MS});`;
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
const realNow=Date.now;
Date.now=()=>providerNow();
let frames=0,done=false;
global.requestAnimationFrame=(fn)=>{
  if(done)return;
  VT+=16.7;frames++;
  if(VT>span+DELAY+60000){done=true;return;}
  setImmediate(()=>fn(VT));
};
eval(src);
const done2=()=>{
  const p=global.__p();
  const s=p.stats;
  const tot=s.seen||1;
  console.log(`DELAY=${(DELAY/1000).toFixed(0)}s POLL=${(POLL/1000).toFixed(0)}s LAG=${(p.lag/1000).toFixed(0)}s  `+
    `trades=${s.seen} applied=${s.applied} clamped=${s.clamped} lost=${s.late} `+
    `(${(s.late/tot*100).toFixed(1)}%)  polls=${s.polls}  drawdown=${((1-p.px/p.pxAth)*100).toFixed(1)}% `+
    `silk=${p.silk.toFixed(3)} k/b=${p.kills}/${p.bites}`);
  process.exit(0);
};
const iv=setInterval(()=>{if(done){clearInterval(iv);done2();}},50);
setTimeout(()=>{done=true;},25000);
