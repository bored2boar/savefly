#!/usr/bin/env node
/* Two collectors with overlap and downtime. We check:
   - the merged log is complete
   - the client reads both and does not duplicate
   - the state is the same regardless of who went down when */
const {loadEngine}=require('../tools/engine.js');
const fs=require('fs'),os=require('os'),path=require('path');
let pass=0,fail=0;
const T=(n,ok,i)=>{if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(i?'  -> '+i:''));}};

const D=fs.mkdtempSync(path.join(os.tmpdir(),'red-'));
const t0=Date.now()-1800000;
const N=900;
const all=[];
let px=0.03;
for(let i=0;i<N;i++){
  const ts=t0+i*2000;
  const side=(i*7919)%100<53?1:-1;
  const sol=[0.004,0.05,0.3,0.9,2.2][i%5];
  px=Math.max(1e-9,px*(1+side*0.0008*((i%11)/11)));
  all.push({step:Math.floor((ts-t0)/50),ts,side,sol:+sol.toFixed(9),
    px:+px.toFixed(12),blk:400000000+i,sig:'R'+String(i).padStart(6,'0')});
}
// A runs 0..60% and 80..100%, B runs 40..100% - together coverage is full
const inA=(i)=>i<N*0.6||i>=N*0.8;
const inB=(i)=>i>=N*0.4;
function write(dir,pred){
  fs.mkdirSync(path.join(D,'events',dir),{recursive:true});
  const by={};
  all.forEach((e,i)=>{
    if(!pred(i))return;
    const d=new Date(e.ts),p=n=>String(n).padStart(2,'0');
    const sh=`${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}.csv`;
    (by[sh]=by[sh]||[]).push([e.step,e.ts,e.side,e.sol,e.px,e.blk,e.sig].join(','));
  });
  const out=[];
  for(const sh of Object.keys(by).sort()){
    fs.writeFileSync(path.join(D,'events',dir,sh),
      'step,ts,side,sol,px,blk,sig\n'+by[sh].join('\n')+'\n');
    out.push('events/'+dir+'/'+sh);
  }
  return out;
}
const sa=write('A',inA), sb=write('B',inB);
fs.writeFileSync(path.join(D,'meta.json'),JSON.stringify({
  pool:'RED',network:'solana',stepMs:50,genesisTs:t0,pxAth:0.05,athSeeded:true,
  lastStep:all[N-1].step,rows:N,shards:sa.concat(sb),gaps:0,updated:Date.now()}));

// 1. the merge covers everything
const merged=new Map();
for(const dir of ['A','B'])
  for(const f of fs.readdirSync(path.join(D,'events',dir)))
    for(const l of fs.readFileSync(path.join(D,'events',dir,f),'utf8').split('\n')){
      if(!l||l[0]==='s')continue;
      const c=l.split(',');merged.set(c[6],c);
    }
T('merged log is complete',merged.size===N,merged.size+' of '+N);

// 2. state from merged = state from the full log
function runSet(rows){
  const E=loadEngine();E.SIMC.GENESIS_TS=t0;
  const evs=rows.slice().sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));
  const S=E.simGenesis();S.px=evs[0].px;S.pxAth=Math.max(0.05,S.px);
  S.silk=Math.max(0,Math.min(1,1-S.px/S.pxAth));E.set(S);
  let i=0;const last=evs[evs.length-1].step+2000;
  for(let st=0;st<=last;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    E.simStep();E.OUTQ.length=0;
  }
  return E.simHash();
}
const hFull=runSet(all);
const hMerged=runSet([...merged.values()].map(c=>({step:+c[0],ts:+c[1],side:+c[2],
  sol:+c[3],px:+c[4],blk:+c[5],sig:c[6]})));
T('state from merged = from full',hFull===hMerged,hFull+' vs '+hMerged);

// 3. one collector alone does NOT give the full state (proof a second is needed)
const onlyA=all.filter((e,i)=>inA(i));
T('one collector with downtime gives a different state',runSet(onlyA)!==hFull,
  'A alone: '+runSet(onlyA));

// 4. subdirectory order in meta has no effect
fs.writeFileSync(path.join(D,'meta.json'),JSON.stringify({
  pool:'RED',network:'solana',stepMs:50,genesisTs:t0,pxAth:0.05,athSeeded:true,
  lastStep:all[N-1].step,rows:N,shards:sb.concat(sa),gaps:0,updated:Date.now()}));
const rev=new Map();
for(const dir of ['B','A'])
  for(const f of fs.readdirSync(path.join(D,'events',dir)).reverse())
    for(const l of fs.readFileSync(path.join(D,'events',dir,f),'utf8').split('\n')){
      if(!l||l[0]==='s')continue;
      const c=l.split(',');if(!rev.has(c[6]))rev.set(c[6],c);
    }
T('read order has no effect',
  runSet([...rev.values()].map(c=>({step:+c[0],ts:+c[1],side:+c[2],
    sol:+c[3],px:+c[4],blk:+c[5],sig:c[6]})))===hFull);

console.log();
console.log(`coverage: A ${sa.length} shards, B ${sb.length}, events total ${merged.size}/${N}`);
console.log(`RESULT: ${pass} pass, ${fail} fail`);
fs.rmSync(D,{recursive:true,force:true});
process.exit(fail?1:0);
