#!/usr/bin/env node
/* Log monitoring. Watches what actually breaks the game:
     - collector died    -> meta.updated goes stale
     - events get lost   -> gaps grows
     - simulation stuck  -> simStep does not move
     - snapshots missing -> ckStep lags behind simStep
   Exits with code 1 on a problem, so it works for cron
   and for a systemd/docker healthcheck.

   node tools/monitor.js [url-or-path] [--watch] [--webhook=URL]
*/
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2);
const src=args.find(a=>!a.startsWith('--'))||'data';
const watch=args.includes('--watch');
const hook=(args.find(a=>a.startsWith('--webhook='))||'').slice(10);
const LIM={updatedS:120,ckLagSteps:24000,simStallS:180};

let prev=null;
async function readMeta(){
  if(/^https?:/.test(src)){
    const r=await fetch(src.replace(/\/$/,'')+'/meta.json',{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r.json();
  }
  const p=path.isAbsolute(src)?src:path.join(__dirname,'..',src);
  return JSON.parse(fs.readFileSync(path.join(p,'meta.json'),'utf8'));
}
async function notify(msg){
  if(!hook)return;
  try{await fetch(hook,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({text:'SAVEFLY: '+msg})});}catch(e){}
}
async function check(){
  let m;
  try{m=await readMeta();}
  catch(e){return {bad:['meta.json unavailable: '+e.message]};}
  const now=Date.now();
  const bad=[],warn=[];
  const age=(now-(m.updated||0))/1000;
  if(age>LIM.updatedS)
    bad.push(`collector silent for ${age.toFixed(0)} s (limit ${LIM.updatedS})`);
  if(m.gaps>0){
    if(prev&&m.gaps>prev.gaps)
      bad.push(`NEW GAP: gaps ${prev.gaps} -> ${m.gaps}, events lost for good`);
    else warn.push(`gaps in the log: ${m.gaps} (old)`);
  }
  if(prev&&m.simStep===prev.simStep&&(now-prev.at)/1000>LIM.simStallS)
    bad.push(`simulation stuck at step ${m.simStep} for ${((now-prev.at)/1000).toFixed(0)} s`);
  const ckLag=(m.simStep||0)-(m.ckStep||0);
  if(ckLag>LIM.ckLagSteps)
    warn.push(`snapshots lag by ${ckLag} steps - cold start will be slow`);
  if(m.athSeeded===false)
    warn.push('ATH not yet taken from daily candles - drawdown is understated');
  if(!m.pool)warn.push('no pool in meta - DNA is not tied to the token');
  prev={gaps:m.gaps||0,simStep:m.simStep||0,at:now};
  return {bad,warn,m,age,ckLag};
}
function report(r){
  const t=new Date().toISOString().slice(11,19);
  if(r.bad&&r.bad.length){
    for(const b of r.bad)console.error(`[${t}] PROBLEM: ${b}`);
    notify(r.bad.join('; '));
    return 1;
  }
  for(const w of (r.warn||[]))console.warn(`[${t}] warning: ${w}`);
  const m=r.m;
  console.log(`[${t}] ok  age ${r.age.toFixed(0)}s  step ${m.simStep}`
    +`  events ${m.rows}  silk ${m.silk}  gen ${m.gen}`
    +`  gaps ${m.gaps||0}  snapshot -${r.ckLag}`);
  return 0;
}
(async()=>{
  if(!watch){process.exit(report(await check()));}
  console.log('monitoring',src,'every 30 s');
  for(;;){
    report(await check());
    await new Promise(r=>setTimeout(r,30000));
  }
})();
