#!/usr/bin/env node
/* Source throughput at 10,000 trades/min.
   The network is replaced by a local block generator: we check that
   the chain parse -> CSV -> simulation -> snapshots keeps up with the rate, and
   count how many requests it costs. */
const {RpcSource}=require('../ingest/rpc-source.js');
const {loadEngine,snapshot}=require('../tools/engine.js');
const fs=require('fs'),os=require('os'),path=require('path');
const RATE=+(process.env.RATE||10000);   // trades/min
const MINS=+(process.env.MINS||10);
const POOL='POOLADDRESS111111111111111111111111111111111';
const WSOL='So11111111111111111111111111111111111111112';
const MINT='TOKENMINT1111111111111111111111111111111111';

const perSlot=Math.max(1,Math.round(RATE/150));   // ~150 slots/min
const slots=Math.round(MINS*150);
console.log(`target: ${RATE.toLocaleString('en-US')} trades/min for ${MINS} min`);
console.log(`        ${perSlot} trades per slot, ${slots} slots`);

// ── block generator in getBlock transactionDetails:accounts format ──
let px=1e-6;
function mkBlock(slot){
  const txs=[];
  // noise: unrelated transactions in the block, like in a real one
  const noise=900;
  for(let i=0;i<noise;i++)
    txs.push({version:0,meta:{err:null,fee:5000,preBalances:[0],postBalances:[0],
      preTokenBalances:[],postTokenBalances:[]},
      transaction:{signatures:['N'+slot+'_'+i]}});
  for(let i=0;i<perSlot;i++){
    const side=((slot*7+i)%100)<53?1:-1;
    const sol=[0.05,0.3,0.9,2.4,11][(slot+i)%5];
    px=Math.max(1e-12,px*(1+side*0.00008));
    const tok=sol/px;
    txs.push({version:0,meta:{err:null,fee:5000,preBalances:[0],postBalances:[0],
      preTokenBalances:[
        {accountIndex:1,mint:WSOL,owner:POOL,uiTokenAmount:{uiAmount:1000}},
        {accountIndex:2,mint:MINT,owner:POOL,uiTokenAmount:{uiAmount:1e9}}],
      postTokenBalances:[
        {accountIndex:1,mint:WSOL,owner:POOL,uiTokenAmount:{uiAmount:1000+side*sol}},
        {accountIndex:2,mint:MINT,owner:POOL,uiTokenAmount:{uiAmount:1e9-side*tok}}]},
      transaction:{signatures:['T'+slot+'_'+i]}});
  }
  return{blockTime:Math.floor(Date.now()/1000)-(slots-slot)*0,transactions:txs};
}
let reqs=0,bytes=0;
const blocks=new Map();
const t0base=Math.floor(Date.now()/1000)-MINS*60;
for(let s=0;s<slots;s++){
  const b=mkBlock(s);
  b.blockTime=t0base+Math.round(s*60/150);
  blocks.set(s,b);
}
const src=new RpcSource({pool:POOL,rpcMode:'block'},()=>{},()=>{});
src.rpc=async(m,p)=>{
  reqs++;
  if(m!=='getBlock')return null;
  const b=blocks.get(p[0]);
  if(b)bytes+=JSON.stringify(b).length;
  return b||null;
};

// ── full chain ──
const D=fs.mkdtempSync(path.join(os.tmpdir(),'thr-'));
fs.mkdirSync(path.join(D,'events'),{recursive:true});
const E=loadEngine();
let simReady=false,genesisTs=0,pxAth=0,rows=0,cks=0;
const outRows=[];
function ingest(evs){
  if(!genesisTs)genesisTs=Math.min(...evs.map(e=>e.ts));
  for(const e of evs){
    e.step=Math.floor((e.ts-genesisTs)/50);
    if(e.px>pxAth)pxAth=e.px;
  }
  evs.sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));
  for(const e of evs)outRows.push([e.step,e.ts,e.side,e.sol,e.px,e.blk,e.sig].join(','));
  rows+=evs.length;
  if(!simReady){
    E.SIMC.GENESIS_TS=genesisTs;
    const S=E.simGenesis();
    S.px=evs[0].px;S.pxAth=Math.max(pxAth,S.px);
    S.silk=Math.max(0,Math.min(1,1-S.px/S.pxAth));
    E.set(S);simReady=true;
  }
  const target=evs[evs.length-1].step;
  let i=0;
  for(let st=E.get().step;st<=target;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    E.simStep();E.OUTQ.length=0;
    if(E.get().step%6000===0)cks++;
  }
}
(async()=>{
  const T0=process.hrtime.bigint();
  for(let s=0;s<slots;s++){
    const evs=await src.fetchSlot(s);
    if(evs.length)ingest(evs);
  }
  const ms=Number(process.hrtime.bigint()-T0)/1e6;
  fs.writeFileSync(path.join(D,'events','all.csv'),
    'step,ts,side,sol,px,blk,sig\n'+outRows.join('\n')+'\n');
  const csvMB=fs.statSync(path.join(D,'events','all.csv')).size/1024/1024;
  const st=src.stats;
  const S=E.get();
  console.log();
  console.log('  getBlock requests :',reqs,`(${(reqs/MINS).toFixed(0)}/min)`);
  console.log('  txs inspected     :',st.fetched.toLocaleString('en-US'));
  console.log('  trades recognized :',st.trades.toLocaleString('en-US'),
    `(${(st.trades/MINS).toFixed(0)}/min)`);
  console.log('  written to log    :',rows.toLocaleString('en-US'));
  console.log('  RPC traffic       :',(bytes/1024/1024).toFixed(0),'MB',
    `(${(bytes/1024/1024/MINS).toFixed(0)} MB/min)`);
  console.log('  log CSV           :',csvMB.toFixed(1),'MB',
    `(${(csvMB/MINS).toFixed(2)} MB/min)`);
  console.log('  snapshots         :',cks);
  console.log('  processing time   :',ms.toFixed(0),'ms');
  console.log('  headroom vs real  :','x'+((MINS*60000)/ms).toFixed(0));
  console.log('  state             : step',S.step.toLocaleString('en-US'),
    'gen',S.gen,'silk',S.silk.toFixed(4),'k/b',S.kills+'/'+S.bites);
  console.log();
  const ok=st.trades>=RATE*MINS*0.99&&rows===st.trades&&(MINS*60000)/ms>10;
  console.log(ok?`  PASS  ${RATE.toLocaleString('en-US')} trades/min sustained, `
    +`${(reqs/MINS).toFixed(0)} requests/min, headroom x${((MINS*60000)/ms).toFixed(0)}`
    :`  FAIL  trades ${st.trades} of ${RATE*MINS}, rows ${rows}`);
  fs.rmSync(D,{recursive:true,force:true});
  process.exit(ok?0:1);
})();
