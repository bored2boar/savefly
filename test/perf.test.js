#!/usr/bin/env node
/* Test plan group A: performance. */
const {loadEngine,snapshot,restore}=require('../tools/engine.js');
const fs=require('fs'),path=require('path'),os=require('os');
let warn=0;
function L(n,v,unit,limit,cmp){
  const bad=cmp==='<'?!(v<limit):!(v>limit);
  if(bad)warn++;
  console.log('  '+(bad?'WARN':'ok  ')+'  '+n.padEnd(42)+
    String(typeof v==='number'?(v<10?v.toFixed(2):Math.round(v).toLocaleString('en-US')):v).padStart(12)+' '+unit+
    (bad?'   (limit '+cmp+' '+limit+')':''));
}
function mkE(){const E=loadEngine();E.SIMC.GENESIS_TS=1789000000000;
  const S=E.simGenesis();S.px=.03;S.pxAth=.03;E.set(S);return E;}

console.log('\n── A3 simulation throughput');
{
  const E=mkE();
  const t0=process.hrtime.bigint();
  const N=500000;
  for(let i=0;i<N;i++){E.simStep();E.OUTQ.length=0;}
  const ms=Number(process.hrtime.bigint()-t0)/1e6;
  L('empty steps',N/ms*1000,'steps/s',200000,'>');
}
{
  const E=mkE();
  const evs=[];for(let i=0;i<20000;i++)evs.push({step:i*5,side:i%3?1:-1,sol:.6,px:.03,blk:i,sig:'a'+i,ts:1789000000000+i*250});
  const t0=process.hrtime.bigint();
  let j=0;const last=evs[evs.length-1].step;
  for(let st=0;st<=last;st++){
    while(j<evs.length&&evs[j].step<=st)E.simApplyEvent(evs[j++]);
    E.simStep();E.OUTQ.length=0;
  }
  const ms=Number(process.hrtime.bigint()-t0)/1e6;
  L('steps with events and entities',last/ms*1000,'steps/s',100000,'>');
}

console.log('\n── A8 snapshot cost');
{
  const E=mkE();
  const evs=[];for(let i=0;i<400;i++)evs.push({step:i,side:i%2?1:-1,sol:1.5,px:.03,blk:i,sig:'s'+i,ts:1789000000000+i*50});
  let j=0;for(let st=0;st<=400;st++){while(j<evs.length&&evs[j].step<=st)E.simApplyEvent(evs[j++]);E.simStep();E.OUTQ.length=0;}
  const S=E.get();
  let t0=process.hrtime.bigint();
  let snap=null;for(let i=0;i<500;i++)snap=snapshot(S,E.simHash());
  L('snapshot write',Number(process.hrtime.bigint()-t0)/1e6/500,'ms',5,'<');
  const js=JSON.stringify(snap);
  L('snapshot size',js.length,'bytes',20000,'<');
  L('entities in snapshot',snap.spiders.length+snap.shots.length,'pcs',0,'>');
  t0=process.hrtime.bigint();
  const E2=loadEngine();
  for(let i=0;i<500;i++)E2.set(restore(E2,JSON.parse(js)));
  L('snapshot restore',Number(process.hrtime.bigint()-t0)/1e6/500,'ms',5,'<');
}

console.log('\n── A7 CSV parsing');
{
  const rows=[];
  for(let i=0;i<200000;i++)
    rows.push(`${i*5},${1789000000000+i*250},${i%2?1:-1},0.512345678,0.024630475916,${448000000+i},SIG${String(i).padStart(10,'0')}`);
  const txt='step,ts,side,sol,px,blk,sig\n'+rows.join('\n')+'\n';
  const t0=process.hrtime.bigint();
  let n=0;
  for(const l of txt.split('\n')){
    if(!l||l.charCodeAt(0)===115)continue;
    const c=l.split(',');
    if(c.length<7)continue;
    const ev={step:+c[0],ts:+c[1],side:+c[2],sol:+c[3],px:+c[4],blk:+c[5],sig:c[6]};
    if(ev.sig&&isFinite(ev.ts))n++;
  }
  const ms=Number(process.hrtime.bigint()-t0)/1e6;
  L('parsing',n/ms*1000,'rows/s',500000,'>');
  L('volume',txt.length/1024/1024,'MB',0,'>');
}

console.log('\n── A5 memory growth');
{
  const E=mkE();
  const evs=[];for(let i=0;i<5000;i++)evs.push({step:i*100,side:i%3?1:-1,sol:.8,px:.03*(1+Math.sin(i/30)*.2),blk:i,sig:'m'+i,ts:1789000000000+i*5000});
  if(global.gc)global.gc();
  const m0=process.memoryUsage().heapUsed;
  let j=0;const last=500000;
  for(let st=0;st<=last;st++){
    while(j<evs.length&&evs[j].step<=st)E.simApplyEvent(evs[j++]);
    E.simStep();E.OUTQ.length=0;
  }
  if(global.gc)global.gc();
  const m1=process.memoryUsage().heapUsed;
  L('heap growth over 500k steps',(m1-m0)/1024/1024,'MB',40,'<');
  L('checkpoint log',E.get().ckLog?E.get().ckLog.length:0,'entries',65,'<');
  L('entities at the end',E.get().spiders.length+E.get().shots.length,'pcs',60,'<');
}

console.log('\n── A4 cold start scaling (tail replay simulation)');
{
  for(const [name,ckSteps,tail] of [['snapshot 5 min ago',6000,6000],
      ['snapshot 30 min ago',36000,36000],['snapshot 2 h ago',144000,144000]]){
    const E=mkE();
    const t0=process.hrtime.bigint();
    const evs=[];const n=Math.round(tail/50*0.4);
    for(let i=0;i<n;i++)evs.push({step:i*Math.max(1,Math.floor(tail/n)),side:i%3?1:-1,sol:.7,px:.03,blk:i,sig:'t'+i,ts:1789000000000+i*50});
    let j=0;
    for(let st=0;st<=tail;st++){
      while(j<evs.length&&evs[j].step<=st)E.simApplyEvent(evs[j++]);
      E.simStep();E.OUTQ.length=0;
    }
    L(name,Number(process.hrtime.bigint()-t0)/1e6,'ms',2000,'<');
  }
}

console.log();
console.log('core/platform:',os.cpus()[0].model.slice(0,40),'| node',process.version);
console.log(warn?`WARNING: ${warn} metrics out of bounds`:'all metrics within bounds');
process.exit(0);
