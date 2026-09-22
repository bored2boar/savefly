#!/usr/bin/env node
/* Fuzzer. Fixed tests check what I anticipated.
   Here - random event streams and a check of invariants that must
   hold always, whatever the input.
   The seed is printed, so any failure is reproducible. */
const {loadEngine,snapshot,restore}=require('../tools/engine.js');
const ITER=+(process.env.ITER||400);
const SEED0=+(process.env.SEED||Date.now()%1e9);

function rng(s){let h=s>>>0;return()=>{h^=h<<13;h>>>=0;h^=h>>17;h^=h<<5;h>>>=0;return h/4294967296;};}
function invariants(S,tag){
  const bad=[];
  const fin=(v)=>Number.isFinite(v);
  if(!fin(S.silk)||S.silk<0||S.silk>1.06)bad.push('silk='+S.silk);
  if(!fin(S.debt)||S.debt<0)bad.push('debt='+S.debt);
  if(!fin(S.px)||S.px<0)bad.push('px='+S.px);
  if(!fin(S.pxAth)||S.pxAth<0)bad.push('pxAth='+S.pxAth);
  if(!fin(S.flow)||S.flow<0)bad.push('flow='+S.flow);
  if(!fin(S.sellAcc)||S.sellAcc<0)bad.push('sellAcc='+S.sellAcc);
  if(!fin(S.buyAcc)||S.buyAcc<0)bad.push('buyAcc='+S.buyAcc);
  if(!Number.isInteger(S.kills)||S.kills<0)bad.push('kills='+S.kills);
  if(!Number.isInteger(S.bites)||S.bites<0)bad.push('bites='+S.bites);
  if(!Number.isInteger(S.gen)||S.gen<1)bad.push('gen='+S.gen);
  if(S.spiders.length>64)bad.push('spiders '+S.spiders.length);
  if(S.shots.length>200)bad.push('shots '+S.shots.length);
  for(const s of S.spiders){
    if(!fin(s.t)||s.t<-0.6||s.t>1.6)bad.push('spider t='+s.t);
    if(!fin(s.hp)||!fin(s.size)||s.size<=0||s.size>3.01)bad.push('spider size='+s.size);
    if(!Number.isInteger(s.spoke)||s.spoke<0||s.spoke>=12)bad.push('spider spoke='+s.spoke);
  }
  for(const s of S.shots){
    if(s.pend===undefined&&(!fin(s.x)||!fin(s.y)))bad.push('shot NaN');
    if(!fin(s.size)||s.size<0)bad.push('shot size='+s.size);
  }
  return bad.length?(tag+': '+bad.join(', ')):null;
}
// random event stream with a wide spread of parameters
function mkStream(r,forceRug){
  const n=5+Math.floor(r()*250);
  const mode=Math.floor(r()*6);
  // some streams are a guaranteed rug with sells dominating, so
  // the fuzzer reaches deaths and generation changes, not just a living fly
  const rug=forceRug||r()<0.25;
  const sellBias=rug?(0.72+r()*0.24):(0.35+r()*0.3);
  const scale=[1e-12,1e-6,1e-3,1,1e3,1e9][Math.floor(r()*6)];
  const evs=[];
  let px=scale*(0.1+r()*10);
  const t0=1789000000000+Math.floor(r()*1e9);
  for(let i=0;i<n;i++){
    let sol;
    switch(mode){
      case 0: sol=r()*0.001; break;              // dust only
      case 1: sol=r()*5; break;                  // normal
      case 2: sol=r()<0.05?r()*1e6:r()*0.5; break; // rare whales
      case 3: sol=Math.pow(10,(r()*14)-8); break;  // wide spread
      case 4: sol=r()<0.5?0:r()*3; break;        // half zeros
      default: sol=r()*100;
    }
    const drift=rug?(0.90+r()*0.07)
      :[0.999,1,1.001,0.9,1.1][Math.floor(r()*5)];
    px=Math.max(1e-300,px*Math.pow(drift,r()*2));
    if(r()<0.03)px=[0,-1,NaN,Infinity,1e308,1e-320][Math.floor(r()*6)];
    if(r()<0.03)sol=[0,-5,NaN,Infinity,-Infinity][Math.floor(r()*5)];
    evs.push({side:r()<sellBias?-1:1,sol,px,
      ts:t0+Math.floor(r()*600000),blk:400000000+i,
      sig:'F'+i+'_'+Math.floor(r()*1e6)});
  }
  evs.sort((a,b)=>a.ts-b.ts);
  const gts=evs[0].ts;
  for(const e of evs)e.step=Math.floor((e.ts-gts)/50);
  return {evs,gts,rug};
}
function run(seed,withCk){
  const r=rng(seed);
  const {evs,gts,rug}=mkStream(r);
  const E=loadEngine();
  E.SIMC.GENESIS_TS=gts;
  const S=E.simGenesis();
  const p0=evs.find(e=>Number.isFinite(e.px)&&e.px>0);
  S.px=p0?p0.px:1;S.pxAth=S.px;S.silk=0;
  E.set(S);
  const last=evs[evs.length-1].step+Math.floor(r()*4000);
  let i=0,deaths=0;
  // a CHAIN of snapshots, not one: check each link separately,
  // because drift could accumulate exactly through several restores
  const every=withCk?(1000+Math.floor(r()*4000)):0;
  const snaps=[];
  for(let st=0;st<=last;st++){
    while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
    const wd=E.get().dead;
    E.simStep();E.OUTQ.length=0;
    if(!wd&&E.get().dead)deaths++;
    const bad=invariants(E.get(),'step '+st);
    if(bad)return {bad,seed};
    if(every&&E.get().step%every===0&&snaps.length<12)
      snaps.push({at:E.get().step,s:snapshot(E.get(),E.simHash())});
  }
  const hash=E.simHash(),gen=E.get().gen;
  // every snapshot in the chain must give the same final state
  for(const sn of snaps){
    const E2=loadEngine();E2.SIMC.GENESIS_TS=gts;
    E2.set(restore(E2,sn.s));
    let j=0;while(j<evs.length&&evs[j].step<=sn.at-1)j++;
    for(let st=sn.at;st<=last;st++){
      while(j<evs.length&&evs[j].step<=st)E2.simApplyEvent(evs[j++]);
      E2.simStep();E2.OUTQ.length=0;
      const bad=invariants(E2.get(),'after snapshot @'+sn.at+' step '+st);
      if(bad)return {bad,seed};
    }
    if(E2.simHash()!==hash)
      return {bad:'snapshot @'+sn.at+' gave '+E2.simHash()+' instead of '+hash,seed};
  }
  // double round-trip: snapshot -> restore -> snapshot must be identical
  if(snaps.length){
    const sn=snaps[snaps.length-1];
    const E3=loadEngine();E3.SIMC.GENESIS_TS=gts;
    E3.set(restore(E3,sn.s));
    const again=snapshot(E3.get(),E3.simHash());
    const a=JSON.stringify(sn.s),b=JSON.stringify(again);
    if(a!==b)return {bad:'double snapshot round-trip changed the data',seed};
  }
  return {hash,seed,n:evs.length,last,deaths,gen,rug,cks:snaps.length};
}
/* CSV round-trip.
   The same class of bug as snapshot drift: rounding on write
   loses precision. toFixed(12) turned a price of 1e-15 into zero,
   and the fly became immortal. Here we check that an event written
   to a log row and read back gives the same state. */
function csvRound(seed){
  const r=rng(seed);
  const {evs,gts}=mkStream(r);
  const clean=evs.filter(e=>Number.isFinite(e.px)&&e.px>0&&Number.isFinite(e.sol)&&e.sol>0);
  if(clean.length<5)return null;
  const lines=clean.map(e=>[e.step,e.ts,e.side,e.sol,e.px,e.blk,e.sig].join(','));
  const back=lines.map(l=>{const c=l.split(',');
    return{step:+c[0],ts:+c[1],side:+c[2],sol:+c[3],px:+c[4],blk:+c[5],sig:c[6]};});
  for(let i=0;i<clean.length;i++){
    const a=clean[i],b=back[i];
    for(const f of ['step','ts','side','sol','px','blk'])
      if(!Object.is(a[f],b[f]))return 'field '+f+': '+a[f]+' -> '+b[f];
    if(a.sig!==b.sig)return 'sig';
  }
  // and the state must be the same
  const run1=(list)=>{
    const E=loadEngine();E.SIMC.GENESIS_TS=gts;
    const S=E.simGenesis();S.px=list[0].px;S.pxAth=S.px;S.silk=0;E.set(S);
    let i=0;const last=list[list.length-1].step+500;
    for(let st=0;st<=last;st++){
      while(i<list.length&&list[i].step<=st)E.simApplyEvent(list[i++]);
      E.simStep();E.OUTQ.length=0;}
    return E.simHash();
  };
  const h1=run1(clean),h2=run1(back);
  return h1===h2?null:('hash '+h1+' vs '+h2);
}
console.log(`fuzzer: ${ITER} iterations, starting seed ${SEED0}`);
let fails=[],maxMs=0,slowSeed=0,totalEv=0,totalSteps=0,csvChecks=0;
let totalDeaths=0,withGen=0,totalCk=0;
const T0=Date.now();
for(let k=0;k<ITER;k++){
  const seed=SEED0+k*7919;
  const t=Date.now();
  let res;
  try{res=run(seed,k%2===0);}
  catch(e){res={bad:'throws: '+e.message,seed};}
  const ms=Date.now()-t;
  if(ms>maxMs){maxMs=ms;slowSeed=seed;}
  if(res.bad){fails.push(res);if(fails.length<=5)console.log('  FAIL seed '+res.seed+': '+res.bad);}
  else{totalEv+=res.n;totalSteps+=res.last;totalDeaths+=res.deaths||0;
    totalCk+=res.cks||0;if(res.gen>1)withGen++;}
  if(k%3===0){
    let cb=null;
    try{cb=csvRound(seed+13);}catch(e){cb='throws: '+e.message;}
    if(cb){fails.push({seed,bad:'CSV: '+cb});
      if(fails.length<=5)console.log('  FAIL seed '+seed+' CSV: '+cb);}
    else csvChecks++;
  }
}
const secs=(Date.now()-T0)/1000;
console.log();
console.log('  events processed:',totalEv.toLocaleString('en-US'));
console.log('  steps           :',totalSteps.toLocaleString('en-US'));
console.log('  longest iteration:',maxMs,'ms (seed',slowSeed+')');
console.log('  deaths          :',totalDeaths,' streams with a generation change:',withGen);
console.log('  snapshot links  :',totalCk);
console.log('  CSV round-trips :',csvChecks);
console.log('  time            :',secs.toFixed(1),'s');
console.log();
// determinism: the same seed twice
const a=run(SEED0+1,false),b=run(SEED0+1,false);
const detOk=a.hash===b.hash;
console.log('  same seed twice:',detOk?'same hash':'DIVERGENCE');
console.log();
console.log(fails.length?`FUZZER: ${fails.length} of ${ITER} failed`
  :`FUZZER: ${ITER} iterations, invariants hold`);
process.exit(fails.length||!detOk?1:0);
