#!/usr/bin/env node
/* B3-B6: snapshots, a generation across a snapshot boundary, a long run. */
const {loadEngine,snapshot,restore}=require('../tools/engine.js');
const fs=require('fs'),path=require('path');
let pass=0,fail=0;
function T(n,fn){try{const r=fn();
  if(r===true||r===undefined){pass++;console.log('  PASS  '+n);}
  else{fail++;console.log('  FAIL  '+n+'  -> '+r);}
}catch(e){fail++;console.log('  FAIL  '+n+'  -> '+e.message);}}

const real=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures','real-pools.json'),'utf8')).trades;
function mkEvs(name,mult){
  const e=real[name].slice().sort((a,b)=>(a.blk-b.blk)||(a.sig<b.sig?-1:1))
    .map(x=>({...x,ts:Date.parse(x.ts)}));
  const t0=Math.min(...e.map(x=>x.ts));
  for(const x of e)x.step=Math.floor((x.ts-t0)/50);
  return {evs:e,t0};
}
function play(E,evs,from,to,startState){
  E.set(startState);
  let i=0;while(i<evs.length&&evs[i].step<=from-1)i++;
  for(let st=from;st<=to;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    E.simStep();E.OUTQ.length=0;
  }
  return E;
}
function fullRun(name,extra){
  const {evs,t0}=mkEvs(name);
  const E=loadEngine();E.SIMC.GENESIS_TS=t0;
  const S=E.simGenesis();S.px=evs[0].px;S.pxAth=evs[0].px;E.set(S);
  const last=Math.max(...evs.map(e=>e.step))+(extra||2000);
  const snaps=new Map();
  let i=0;
  for(let st=0;st<=last;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    E.simStep();E.OUTQ.length=0;
    const cur=E.get().step;
    if(cur%2000===0)snaps.set(cur,snapshot(E.get(),E.simHash()));
  }
  return {E,evs,t0,last,snaps,hash:E.simHash(),state:E.get()};
}

console.log('\n── B3/B4 snapshots vs full replay');
const base=fullRun('PAID[trend]');
T('B3 mid snapshot = full replay',()=>{
  const keys=[...base.snaps.keys()].sort((a,b)=>a-b);
  const mid=keys[Math.floor(keys.length/2)];
  const snap=base.snaps.get(mid);
  const E=loadEngine();E.SIMC.GENESIS_TS=base.t0;
  play(E,base.evs,mid,base.last,restore(E,snap));
  return E.simHash()===base.hash||'hash '+E.simHash()+' vs '+base.hash;});
T('B4 oldest snapshot = newest',()=>{
  const keys=[...base.snaps.keys()].sort((a,b)=>a-b);
  const res=[];
  for(const k of [keys[0],keys[1],keys[Math.floor(keys.length/2)],keys[keys.length-2]]){
    const E=loadEngine();E.SIMC.GENESIS_TS=base.t0;
    play(E,base.evs,k,base.last,restore(E,base.snaps.get(k)));
    res.push(k+':'+E.simHash());
  }
  const bad=res.filter(r=>r.split(':')[1]!==base.hash);
  return bad.length===0||'diverging: '+bad.join(' ');});
T('B4 every snapshot gives the same final state',()=>{
  const keys=[...base.snaps.keys()].sort((a,b)=>a-b);
  let bad=0;
  for(const k of keys){
    const E=loadEngine();E.SIMC.GENESIS_TS=base.t0;
    play(E,base.evs,k,base.last,restore(E,base.snaps.get(k)));
    if(E.simHash()!==base.hash)bad++;
  }
  return bad===0||bad+' of '+keys.length+' snapshots diverged';});

console.log('\n── B5 death and hatching across a snapshot boundary');
T('B5 generation changes after a snapshot',()=>{
  // artificial rug: guaranteed death in the middle
  const {evs,t0}=mkEvs('CALI[trend]');
  const ath=Math.max(...evs.map(e=>e.px));
  const mod=evs.map((e,i)=>({...e,px:ath*(1-0.9*(i/evs.length)),
    side:(i/evs.length>0.2&&i%2===0)?-1:e.side}));
  const E0=loadEngine();E0.SIMC.GENESIS_TS=t0;
  const S0=E0.simGenesis();S0.px=mod[0].px;S0.pxAth=mod[0].px;E0.set(S0);
  const last=Math.max(...mod.map(e=>e.step))+6000;
  const snaps=new Map();let i=0,deaths=0;
  for(let st=0;st<=last;st++){
    while(i<mod.length&&mod[i].step<=st)E0.simApplyEvent(mod[i++]);
    const wd=E0.get().dead;E0.simStep();E0.OUTQ.length=0;
    if(!wd&&E0.get().dead)deaths++;
    if(E0.get().step%1500===0)snaps.set(E0.get().step,snapshot(E0.get(),E0.simHash()));
  }
  const h=E0.simHash(),gen=E0.get().gen;
  if(deaths===0)return 'scenario produced no death';
  const keys=[...snaps.keys()].sort((a,b)=>a-b);
  let bad=0;
  for(const k of keys){
    const E=loadEngine();E.SIMC.GENESIS_TS=t0;
    play(E,mod,k,last,restore(E,snaps.get(k)));
    if(E.simHash()!==h)bad++;
  }
  return bad===0||bad+' of '+keys.length+' snapshots diverged (deaths '+deaths+', gen '+gen+')';});

console.log('\n── B6 long run, two instances');
T('B6 1M steps without divergence',()=>{
  const A=loadEngine(),B=loadEngine();
  for(const E of [A,B]){E.SIMC.GENESIS_TS=1789000000000;
    const S=E.simGenesis();S.px=.03;S.pxAth=.03;E.set(S);}
  const evs=[];
  for(let i=0;i<8000;i++)evs.push({step:i*125,side:i%3?1:-1,sol:.6+((i*37)%100)/100,
    px:.03*(1+Math.sin(i/70)*.35),blk:i,sig:'L'+i,ts:1789000000000+i*6250});
  let ia=0,ib=0,bad=0;
  for(let st=0;st<=1000000;st++){
    while(ia<evs.length&&evs[ia].step<=st)A.simApplyEvent(evs[ia++]);
    while(ib<evs.length&&evs[ib].step<=st)B.simApplyEvent(evs[ib++]);
    A.simStep();B.simStep();A.OUTQ.length=0;B.OUTQ.length=0;
    if(st%50000===0&&A.simHash()!==B.simHash())bad++;
  }
  return (bad===0&&A.simHash()===B.simHash())
    ||'divergences '+bad+' final '+A.simHash()+'/'+B.simHash();});

console.log();
console.log(`RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
