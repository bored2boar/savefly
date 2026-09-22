#!/usr/bin/env node
/* Test plan groups C, D, E: edge data, extreme economics,
   numeric stability. All at engine level, no DOM. */
const {loadEngine,snapshot,restore}=require('../tools/engine.js');
let pass=0,fail=0;
function T(name,fn){
  try{
    const r=fn();
    if(r===true||r===undefined){pass++;console.log('  PASS  '+name);}
    else{fail++;console.log('  FAIL  '+name+'  -> '+r);}
  }catch(e){fail++;console.log('  FAIL  '+name+'  -> throws: '+e.message);}
}
function fresh(px){
  const E=loadEngine();
  E.SIMC.GENESIS_TS=1789000000000;
  const S=E.simGenesis();
  S.px=px===undefined?0.03:px;S.pxAth=S.px;S.silk=0;
  E.set(S);return E;
}
function run(E,evs,steps){
  let i=0;
  evs=evs.slice().sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||((a.sig||'')<(b.sig||'')?-1:1));
  for(let st=0;st<=steps;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    E.simStep();E.OUTQ.length=0;
  }
  return E.get();
}
const ok=(v)=>Number.isFinite(v);
function sane(S){
  if(!ok(S.silk)||S.silk<0||S.silk>1.06)return 'silk='+S.silk;
  if(!ok(S.debt)||S.debt<0)return 'debt='+S.debt;
  if(!ok(S.px)||S.px<0)return 'px='+S.px;
  if(!ok(S.pxAth)||S.pxAth<0)return 'pxAth='+S.pxAth;
  if(!Number.isInteger(S.kills)||!Number.isInteger(S.bites))return 'counters';
  if(!Number.isInteger(S.gen)||S.gen<1)return 'gen='+S.gen;
  for(const s of S.spiders)if(!ok(s.t)||!ok(s.hp)||!ok(s.size))return 'spider NaN';
  for(const s of S.shots)if(s.pend===undefined&&(!ok(s.x)||!ok(s.y)))return 'shot NaN';
  return null;
}

console.log('\n── C. Feed edge cases');
T('C1 empty log',()=>{const S=run(fresh(),[],200);return sane(S)||true;});
T('C2 one event',()=>{const S=run(fresh(),[{step:5,side:-1,sol:1,px:0.03,blk:1,sig:'a',ts:1789000000250}],400);
  return sane(S)||(S.evCount===1||'evCount='+S.evCount);});
T('C3 all events on one step',()=>{
  const evs=[];for(let i=0;i<50;i++)evs.push({step:10,side:i%2?1:-1,sol:.5,px:.03,blk:100-i,sig:'s'+i,ts:1789000000500});
  const A=run(fresh(),evs,600),hA=A.step;
  const B=run(fresh(),evs.slice().reverse(),600);
  const E1=loadEngine();
  return sane(A)||(hA===B.step||'steps differ');});
T('C4 events out of order in CSV',()=>{
  const evs=[];for(let i=0;i<40;i++)evs.push({step:i*5,side:i%3?1:-1,sol:.4,px:.03,blk:i,sig:'z'+i,ts:1789000000000+i*250});
  const a=run(fresh(),evs,400);
  const b=run(fresh(),evs.slice().reverse(),400);
  const E=loadEngine();
  return (a.kills===b.kills&&a.bites===b.bites)||'order matters: '+a.kills+'/'+b.kills;});
T('C6 corrupted values in an event',()=>{
  const bad=[{step:5,side:-1,sol:NaN,px:.03,blk:1,sig:'n1'},
             {step:6,side:1,sol:undefined,px:.03,blk:2,sig:'n2'},
             {step:7,side:-1,sol:'abc',px:.03,blk:3,sig:'n3'},
             {step:8,side:0,sol:1,px:.03,blk:4,sig:'n4'},
             {step:9,side:-1,sol:1,px:NaN,blk:5,sig:'n5'}];
  const S=run(fresh(),bad,300);return sane(S)||true;});
T('C7 sol: 0 / negative / 1e9',()=>{
  const evs=[{step:5,side:-1,sol:0,px:.03,blk:1,sig:'a'},
             {step:6,side:-1,sol:-5,px:.03,blk:2,sig:'b'},
             {step:7,side:-1,sol:1e9,px:.03,blk:3,sig:'c'},
             {step:8,side:1,sol:1e9,px:.03,blk:4,sig:'d'}];
  const S=run(fresh(),evs,600);
  const big=S.spiders.some(s=>s.size>3.001);
  return sane(S)||(big?'size not capped':true);});
T('C8 px: 0 / negative',()=>{
  const evs=[{step:5,side:1,sol:1,px:0,blk:1,sig:'a'},
             {step:6,side:1,sol:1,px:-0.01,blk:2,sig:'b'}];
  const S=run(fresh(),evs,300);return sane(S)||true;});
T('C9 price spike x1e6 and back (ATH)',()=>{
  const evs=[];
  for(let i=0;i<20;i++)evs.push({step:i*10,side:1,sol:.5,px:0.03,blk:i,sig:'p'+i,ts:1789000000000+i*500});
  evs.push({step:205,side:1,sol:.5,px:30000,blk:99,sig:'spike',ts:1789000010250});
  for(let i=0;i<20;i++)evs.push({step:220+i*10,side:1,sol:.5,px:0.03,blk:200+i,sig:'q'+i,ts:1789000011000+i*500});
  const S=run(fresh(),evs,600);
  const poisoned=S.pxAth>1;
  return sane(S)||(poisoned?'ATH poisoned: '+S.pxAth:true);});
T('C16 step very far ahead (clock skew)',()=>{
  const E=fresh();const S=E.get();S.step=1e6;S.genStep=1e6;
  const r=run(E,[{step:1000005,side:-1,sol:1,px:.03,blk:1,sig:'a'}],1000400);
  return sane(r)||true;});

console.log('\n── D. Extreme economics');
T('D1 instant rug -99.9%',()=>{
  const evs=[];let px=0.03;
  for(let i=0;i<200;i++){px=0.03*(1-0.999*i/200);
    evs.push({step:i*20,side:-1,sol:1.2,px,blk:i,sig:'r'+i,ts:1789000000000+i*1000});}
  const S=run(fresh(),evs,20000);
  return (S.gen>1||S.dead)||'did not die: gen='+S.gen+' silk='+S.silk.toFixed(3);});
T('D2 endless pump',()=>{
  const evs=[];let px=0.03;
  for(let i=0;i<300;i++){px*=1.02;
    evs.push({step:i*20,side:1,sol:1,px,blk:i,sig:'u'+i,ts:1789000000000+i*1000});}
  const S=run(fresh(),evs,8000);
  return (S.gen===1&&S.silk<0.02)||'gen='+S.gen+' silk='+S.silk.toFixed(4);});
T('D3 zero activity for 2 hours',()=>{
  const S=run(fresh(),[{step:5,side:1,sol:1,px:.03,blk:1,sig:'a'}],144000);
  return (!S.dead&&S.gen===1)||'died without events: gen='+S.gen;});
T('D4 buys only',()=>{
  const evs=[];for(let i=0;i<200;i++)evs.push({step:i*10,side:1,sol:.8,px:.03,blk:i,sig:'b'+i,ts:1789000000000+i*500});
  const S=run(fresh(),evs,4000);
  return (S.bites===0&&S.silk<0.05)||'bites='+S.bites+' silk='+S.silk.toFixed(3);});
T('D5 sells only',()=>{
  const evs=[];for(let i=0;i<400;i++)evs.push({step:i*10,side:-1,sol:.8,px:.03,blk:i,sig:'s'+i,ts:1789000000000+i*500});
  const S=run(fresh(),evs,8000);
  return (S.gen>1||S.dead||S.silk>0.5)||'survived: silk='+S.silk.toFixed(3)+' bites='+S.bites;});
T('D6 one whale 10000 SOL',()=>{
  const S=run(fresh(),[{step:5,side:-1,sol:10000,px:.03,blk:1,sig:'w'}],3000);
  const mx=Math.max(0,...S.spiders.map(s=>s.size));
  return sane(S)||((!S.dead&&S.gen===1)||'whale killed alone: gen='+S.gen);});
T('D7 dust only',()=>{
  const evs=[];for(let i=0;i<300;i++)evs.push({step:i*5,side:i%2?1:-1,sol:0.005,px:.03,blk:i,sig:'d'+i,ts:1789000000000+i*250});
  const S=run(fresh(),evs,2000);
  return (S.spiders.length===0&&S.shots.length===0)||'entities from dust: '+S.spiders.length+'/'+S.shots.length;});
T('D8 death-hatch chain',()=>{
  const evs=[];let px=0.03;
  for(let i=0;i<600;i++){
    px=0.03*(0.06+0.94*Math.abs(Math.sin(i/40)));
    evs.push({step:i*10,side:-1,sol:1.5,px,blk:i,sig:'c'+i,ts:1789000000000+i*500});}
  const S=run(fresh(),evs,14000);
  return (S.gen>=2&&sane(S)===null)||'gen='+S.gen+' '+(sane(S)||'');});
T('D9 price exactly 0 in state',()=>{
  const E=fresh(0);const S=run(E,[{step:5,side:1,sol:1,px:0,blk:1,sig:'a'}],400);
  return sane(S)||true;});
T('D10 ATH = 0',()=>{
  const E=loadEngine();E.SIMC.GENESIS_TS=1789000000000;
  const S0=E.simGenesis();S0.px=0;S0.pxAth=0;E.set(S0);
  const S=run(E,[{step:5,side:-1,sol:1,px:0,blk:1,sig:'a'}],400);
  return sane(S)||true;});

console.log('\n── E. Numeric stability');
T('E1 price 1e-12',()=>{
  const evs=[];for(let i=0;i<100;i++)evs.push({step:i*10,side:i%2?1:-1,sol:.5,px:1e-12*(1+i*0.01),blk:i,sig:'t'+i,ts:1789000000000+i*500});
  const S=run(fresh(1e-12),evs,2000);return sane(S)||true;});
T('E2 price 1e12',()=>{
  const evs=[];for(let i=0;i<100;i++)evs.push({step:i*10,side:i%2?1:-1,sol:.5,px:1e12*(1+i*0.01),blk:i,sig:'g'+i,ts:1789000000000+i*500});
  const E=fresh(1e12);const S=run(E,evs,2000);
  const h=E.simHash();
  return sane(S)||(/^[0-9a-f]{8}$/.test(h)||'hash corrupted: '+h);});
T('E3 Infinity in an event',()=>{
  const S=run(fresh(),[{step:5,side:-1,sol:Infinity,px:Infinity,blk:1,sig:'i'},
                        {step:6,side:1,sol:-Infinity,px:.03,blk:2,sig:'j'}],400);
  return sane(S)||true;});
T('E4 step > 2^31',()=>{
  const E=fresh();const S=E.get();S.step=2147483000;S.genStep=S.step;
  for(let i=0;i<1200;i++){E.simStep();E.OUTQ.length=0;}
  const h=E.simHash();
  return (/^[0-9a-f]{8}$/.test(h)&&sane(E.get())===null)||'hash='+h+' '+(sane(E.get())||'');});
T('E5 accumulation over 300k steps',()=>{
  const E=fresh();
  const evs=[];for(let i=0;i<3000;i++)evs.push({step:i*100,side:i%3?1:-1,sol:.6,px:0.03*(1+Math.sin(i/50)*0.3),blk:i,sig:'a'+i,ts:1789000000000+i*5000});
  const S=run(E,evs,300000);
  return sane(S)||true;});

console.log();
console.log(`RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
