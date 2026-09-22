#!/usr/bin/env node
/* Collector under load. The provider is replaced by a local
   generator, the rate is configurable. We measure whether the collector keeps up:
   CSV writes, simulation progress, snapshots. */
const fs=require('fs'),os=require('os'),path=require('path');
const RATE=+(process.env.RATE||500);      // trades/min
const MINS=+(process.env.MINS||30);       // how many minutes of history to generate
const POLL=+(process.env.POLL||0)||0;
const ROOT=path.resolve(__dirname,'..');
const D=fs.mkdtempSync(path.join(os.tmpdir(),'load-'));
fs.mkdirSync(path.join(D,'events'),{recursive:true});
const cfg={network:'t',pool:'P',pollMs:25,stepMs:50,dataDir:D,
  gapWarnSteps:600,ckSteps:6000,shardMaxMB:4};
fs.writeFileSync(path.join(D,'cfg.json'),JSON.stringify(cfg));

const total=Math.round(RATE*MINS);
const t0=Date.now()-MINS*60000;
const all=[];
let px=0.03;
for(let i=0;i<total;i++){
  const ts=t0+Math.round(i/RATE*60000);
  const side=(i*7919)%100<53?1:-1;
  const sol=[0.004,0.03,0.2,0.8,2.4,11][i%6];
  px=Math.max(1e-9,px*(1+side*0.0006*((i%13)/13+0.3)));
  all.push({attributes:{block_timestamp:new Date(ts).toISOString(),
    kind:side>0?'buy':'sell',
    from_token_amount:String(side>0?sol:1),to_token_amount:String(side>0?1:sol),
    price_to_in_usd:String(side>0?px:0),price_from_in_usd:String(side>0?0:px),
    block_number:400000000+i,tx_hash:'S'+String(i).padStart(9,'0')}});
}
// The provider indexes by time, not in batches: one poll makes
// visible as many trades as happened during the poll interval.
// It serves a window of the last 300. Hence the collector's ceiling:
//   300 trades / poll interval.
let polls=0,visible=0;
// The real poll interval in prod is POLL_REAL. The test runs faster,
// but each of its polls brings as many trades as a real poll
// would bring over POLL_REAL. That way the ceiling is computed correctly,
// and the run does not take hours.
const POLL_REAL=+(process.env.POLL_REAL||8000);
const perPoll=Math.max(1,Math.round(RATE/60*(POLL_REAL/1000)));
const CEIL=Math.round(300/(POLL_REAL/1000)*60);
global.fetch=async(u)=>{
  if(String(u).includes('/ohlcv/'))
    return{ok:true,json:async()=>({data:{attributes:{ohlcv_list:[[t0/1000,0.09,0.09,0.09,0.03,0]]}}})};
  polls++;
  visible=Math.min(total,visible+Math.max(1,perPoll));
  const win=all.slice(Math.max(0,visible-300),visible);
  return{ok:true,json:async()=>({data:win.slice().reverse()})};
};
process.env.CFG=path.join(D,'cfg.json');
const origCwd=process.cwd();
process.chdir(D);
// the collector expects ../tools - make a symlink
try{fs.symlinkSync(path.join(ROOT,'tools'),path.join(D,'tools'));}catch(e){}
const realLog=console.log,realWarn=console.warn,realErr=console.error;
let lines=0,gaps=0,deaths=0;
console.log=(...a)=>{lines++;if(String(a[0]).includes('[death]'))deaths++;};
console.warn=(...a)=>{if(String(a[0]).includes('[gap]'))gaps++;};
console.error=()=>{};
const T0=process.hrtime.bigint();
require(path.join(ROOT,'ingest','ingest.js'));
const iv=setInterval(()=>{
  if(visible>=total){
    clearInterval(iv);
    setTimeout(()=>{
      const wall=Number(process.hrtime.bigint()-T0)/1e6;
      console.log=realLog;console.warn=realWarn;console.error=realErr;
      const meta=JSON.parse(fs.readFileSync(path.join(D,'meta.json'),'utf8'));
      const evDir=path.join(D,'events');
      const shards=fs.readdirSync(evDir);
      const bytes=shards.reduce((a,f)=>a+fs.statSync(path.join(evDir,f)).size,0);
      const ckSz=fs.existsSync(path.join(D,'checkpoints.jsonl'))
        ?fs.statSync(path.join(D,'checkpoints.jsonl')).size:0;
      const rows=shards.reduce((a,f)=>a+fs.readFileSync(path.join(evDir,f),'utf8')
        .split('\n').filter(l=>l&&l[0]!=='s').length,0);
      const simSteps=meta.simStep||0;
      console.log();
      console.log(`  rate              : ${RATE} trades/min, ${MINS} min of history`);
      console.log(`  poll interval     : ${POLL_REAL} ms -> ${perPoll} trades per poll`);
      console.log(`  provider CEILING  : ${CEIL.toLocaleString('en-US')} trades/min (300 per poll)`);
      console.log(`  events generated  : ${total.toLocaleString('en-US')}`);
      console.log(`  events in log     : ${rows.toLocaleString('en-US')} ${rows===total?'(all)':'(LOST '+(total-rows)+')'}`);
      console.log(`  polls             : ${polls}`);
      console.log(`  simulation steps  : ${simSteps.toLocaleString('en-US')}`);
      console.log(`  shards            : ${shards.length}, ${(bytes/1024).toFixed(0)} KB`);
      console.log(`  checkpoints.jsonl : ${(ckSz/1024).toFixed(0)} KB`);
      console.log(`  deaths            : ${deaths}, gaps: ${gaps}`);
      console.log(`  processing time   : ${wall.toFixed(0)} ms`);
      console.log(`  throughput        : ${Math.round(total/wall*1000).toLocaleString('en-US')} events/s`);
      console.log(`  real time          : ${(MINS*60).toLocaleString('en-US')} s of history in ${(wall/1000).toFixed(1)} s`);
      const speedup=(MINS*60000)/wall;
      console.log(`  headroom           : x${speedup.toFixed(0)} vs real time`);
      console.log();
      const under=RATE<=CEIL;
      if(under&&rows===total)console.log('  PASS  under the ceiling - zero loss, headroom x'+speedup.toFixed(0));
      else if(!under)console.log(`  EXPECTED  rate ${RATE} > ceiling ${CEIL}: lost `
        +`${(total-rows).toLocaleString('en-US')} (${((1-rows/total)*100).toFixed(0)}%), gaps ${gaps}`);
      else console.log('  FAIL  losses under the ceiling');
      process.chdir(origCwd);
      fs.rmSync(D,{recursive:true,force:true});
      process.exit(0);
    },600);
  }
},15);
setTimeout(()=>{console.log=realLog;realLog('  TIMEOUT');process.exit(1);},120000);
