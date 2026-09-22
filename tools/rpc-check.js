#!/usr/bin/env node
/* Is this RPC endpoint good enough.
   Before paying for a plan, check not the marketing but
   what we actually need: getBlock with transactionDetails
   accounts on finalized, stable, ~150 times per minute.
   Measures latency, throttling, traffic and whether it keeps up.

   node tools/rpc-check.js [url] [seconds]
*/
const URL=process.argv[2]||process.env.RPC||'https://api.mainnet-beta.solana.com';
const SECS=+(process.argv[3]||45);
const NEED_RPM=150;                       // one request per slot

let reqs=0,ok=0,throttled=0,errs=0,bytes=0;
const lat=[];
async function post(body){
  const r=await fetch(URL,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  reqs++;
  if(r.status===429||r.status===503){throttled++;return null;}
  if(!r.ok){errs++;return null;}
  const t=await r.text();
  bytes+=t.length;
  try{return JSON.parse(t);}catch(e){errs++;return null;}
}
async function rpc(m,p){
  const j=await post({jsonrpc:'2.0',id:1,method:m,params:p});
  if(!j)return null;
  if(j.error){errs++;return null;}
  return j.result;
}
(async()=>{
  console.log('endpoint:',URL);
  console.log('need    :',NEED_RPM,'requests/min (one getBlock per slot)');
  console.log();
  const slot=await rpc('getSlot',[{commitment:'finalized'}]);
  if(!slot){console.log('getSlot does not work - endpoint unusable');process.exit(1);}
  console.log('finalized slot:',slot);
  // rate needed in prod: 150/min = 2.5/s
  const interval=Math.round(60000/NEED_RPM);
  const t0=Date.now();
  let s=slot-Math.round(SECS*2.5)-20;
  while(Date.now()-t0<SECS*1000){
    const t=Date.now();
    const b=await rpc('getBlock',[s++,{encoding:'jsonParsed',
      transactionDetails:'accounts',rewards:false,commitment:'finalized',
      maxSupportedTransactionVersion:1}]);
    if(b)  {ok++;lat.push(Date.now()-t);}
    const wait=interval-(Date.now()-t);
    if(wait>0)await new Promise(r=>setTimeout(r,wait));
  }
  const secs=(Date.now()-t0)/1000;
  lat.sort((a,b)=>a-b);
  const p=(q)=>lat.length?lat[Math.min(lat.length-1,Math.floor(lat.length*q))]:0;
  const rpm=reqs/secs*60;
  const mbMin=bytes/1024/1024/secs*60;
  console.log();
  console.log('  requests made    :',reqs,`(${rpm.toFixed(0)}/min)`);
  console.log('  getBlock ok      :',ok);
  console.log('  throttles (429)  :',throttled);
  console.log('  errors           :',errs);
  console.log('  latency p50/p95  :',p(.5)+' / '+p(.95),'ms');
  console.log('  traffic          :',mbMin.toFixed(0),'MB/min at this rate');
  console.log();
  const rate=ok/Math.max(1,reqs);
  const verdict=[];
  if(rate<0.98)verdict.push(`success rate ${(rate*100).toFixed(0)}% - too low, need >98%`);
  if(throttled>0)verdict.push(`throttled ${throttled} times out of ${reqs} requests`);
  if(p(.95)>2000)verdict.push(`p95 latency ${p(.95)} ms - blocks will not keep up`);
  if(verdict.length){
    console.log('NOT SUITABLE:');
    for(const v of verdict)console.log('  -',v);
    console.log();
    console.log('You need a plan that handles 150 getBlock/min on finalized');
    console.log('with transactionDetails=accounts (heavy requests, ~3 MB each).');
    process.exit(1);
  }
  console.log('SUITABLE: handles the required rate');
  console.log(`Traffic budget: about ${mbMin.toFixed(0)} MB/min`
    +` = ${(mbMin*60/1024).toFixed(1)} GB/h at full slot coverage.`);
  console.log('On a quiet token there will be a few requests per minute, not 150.');
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
