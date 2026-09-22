#!/usr/bin/env node
/* Log consistency. This breaks silently: the data looks
   normal, but everyone's state differs or the ATH is garbage. */
const {loadEngine,snapshot,restore}=require('../tools/engine.js');
const fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;
const T=(n,ok,i)=>{if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(i?'  -> '+i:''));}};

function mkData(rows,meta){
  const D=fs.mkdtempSync(path.join(os.tmpdir(),'cons-'));
  fs.mkdirSync(path.join(D,'events','A'),{recursive:true});
  fs.writeFileSync(path.join(D,'events','A','2026-09-19T10.csv'),
    'step,ts,side,sol,px,blk,sig\n'+rows.join('\n')+'\n');
  fs.writeFileSync(path.join(D,'meta.json'),JSON.stringify(meta));
  return D;
}
function row(step,ts,side,sol,px,blk,sig){
  return [step,ts,side,sol,px,blk,sig].join(',');
}
const t0=1789000000000;

console.log('\n── 1. mixed price units ──');
{
  // first half in USD (1e-5), second in SOL (1e-7) - as would happen when
  // changing source on a live log
  const rows=[];
  for(let i=0;i<60;i++)
    rows.push(row(i*20,t0+i*1000,i%2?1:-1,0.7,i<30?1.5e-5:1.0e-7,4e8+i,'M'+i));
  const D=mkData(rows,{schema:2,pool:'P',stepMs:50,genesisTs:t0,
    pxAth:1.5e-5,priceUnit:'USD',shards:['events/A/2026-09-19T10.csv'],lastStep:1180});
  let out='';
  try{out=execFileSync(process.execPath,[path.join(ROOT,'tools','replay.js')],
    {env:Object.assign({},process.env,{DATA:D}),encoding:'utf8',timeout:60000});}
  catch(e){out=String(e.stdout||'');}
  const m=/drawdown\s*:\s*([\d.]+)%/.exec(out);
  const dd=m?+m[1]:-1;
  // a USD->SOL switch is a 150x drop: drawdown must be ~99%
  T('changing price units gives a catastrophic drawdown',dd>95,
    'drawdown '+dd+'% - i.e. changing source on a live log kills the fly');
  const hasGuard=fs.readFileSync(path.join(ROOT,'ingest','ingest.js'),'utf8')
    .indexOf('priceUnit')>=0 && /priceUnit[\s\S]{0,400}(throw|process\.exit|mismatch)/.test(
      fs.readFileSync(path.join(ROOT,'ingest','ingest.js'),'utf8'));
  T('collector guards against unit changes',hasGuard,'no guard');
  fs.rmSync(D,{recursive:true,force:true});
}

console.log('\n── 2. genesis seed without pool in meta ──');
{
  const rows=[row(0,t0,1,0.7,1e-5,4e8,'S1')];
  const D=mkData(rows,{schema:2,stepMs:50,genesisTs:t0,pxAth:1e-5,
    shards:['events/A/2026-09-19T10.csv'],lastStep:0});
  const html=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8');
  const hasFallbackWarn=/meta\.pool[\s\S]{0,300}(warn|log\()/.test(html);
  T('client warns if pool is missing from meta',hasFallbackWarn,
    'the seed stays a demo constant, the DNA will not match the collector');
  fs.rmSync(D,{recursive:true,force:true});
}

console.log('\n── 3. two collectors with different settings ──');
{
  const ing=fs.readFileSync(path.join(ROOT,'ingest','ingest.js'),'utf8');
  const guarded=/minUsd[\s\S]{0,500}(mismatch|writer[\s\S]{0,80}conflict)/.test(ing);
  T('collector checks its config against meta',guarded,
    'two collectors with different minUsd or source write into one log unnoticed');
}

console.log('\n── 4. loadSeen after rotation ──');
{
  const D=fs.mkdtempSync(path.join(os.tmpdir(),'rot-'));
  fs.mkdirSync(path.join(D,'events','A','archive'),{recursive:true});
  fs.writeFileSync(path.join(D,'events','A','archive','2026-09-19T08.csv'),
    'step,ts,side,sol,px,blk,sig\n'+row(0,t0,1,0.7,1e-5,4e8,'OLD1')+'\n');
  fs.writeFileSync(path.join(D,'events','A','2026-09-19T10.csv'),
    'step,ts,side,sol,px,blk,sig\n'+row(100,t0+5000,1,0.7,1e-5,4e8+1,'NEW1')+'\n');
  fs.writeFileSync(path.join(D,'meta.json'),JSON.stringify({schema:2,pool:'P',
    stepMs:50,genesisTs:t0,pxAth:1e-5,
    shards:['events/A/2026-09-19T10.csv'],lastStep:100}));
  const ing=fs.readFileSync(path.join(ROOT,'ingest','ingest.js'),'utf8');
  const readsArchive=/function loadSeen\(\)\{[\s\S]{0,900}withFileTypes/.test(ing);
  T('loadSeen reads the archive',readsArchive,
    'after a restart archived signatures are not in seen - duplicates in the log are possible');
  // replay must see the archive too
  let out='';
  try{out=execFileSync(process.execPath,[path.join(ROOT,'tools','replay.js')],
    {env:Object.assign({},process.env,{DATA:D}),encoding:'utf8',timeout:60000});}
  catch(e){out=String(e.stdout||'');}
  const m=/^log\s*:\s*(\d+)/m.exec(out);
  T('replay reads the archive',m&&+m[1]===2,'events '+(m?m[1]:'?')+' of 2');
  fs.rmSync(D,{recursive:true,force:true});
}

console.log('\n── 5. deaths.csv with two collectors ──');
{
  const ing=fs.readFileSync(path.join(ROOT,'ingest','ingest.js'),'utf8');
  const perWriter=/dtPath[\s\S]{0,200}WRITER/.test(ing);
  T('deaths.csv is split per collector',perWriter,
    'two collectors duplicate death rows into one file');
}

console.log('\n── 6. snapshot from another schema ──');
{
  const E=loadEngine();
  const S=E.simGenesis();S.px=1e-5;S.pxAth=1e-5;E.set(S);
  for(let i=0;i<50;i++){E.simStep();E.OUTQ.length=0;}
  const snap=snapshot(E.get(),E.simHash());
  delete snap.flow; delete snap.sellAcc;   // snapshot from an older version
  const E2=loadEngine();
  let ok=true,why='';
  try{
    E2.set(restore(E2,snap));
    for(let i=0;i<100;i++){E2.simStep();E2.OUTQ.length=0;}
    const s=E2.get();
    if(!isFinite(s.silk)||!isFinite(s.flow))ok=false,why='NaN in state';
  }catch(e){ok=false;why=e.message;}
  T('snapshot without new fields does not break state',ok,why);
}
console.log();
console.log(`RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
