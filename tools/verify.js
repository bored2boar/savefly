#!/usr/bin/env node
/* Snapshot chain verification.
   A snapshot is the collector's claim. But snapshots form a chain:
   replaying the events between ck[i] and ck[i+1] must give exactly
   ck[i+1].hash. One wrong snapshot breaks a link, and it shows.
   So trust is needed only for the FIRST snapshot, and everything after
   is checked by arithmetic. */
const fs=require('fs'),path=require('path');
const {loadEngine,restore,snapshot}=require('./engine.js');
const ROOT=path.resolve(__dirname,'..');
const D0=process.env.DATA||'data';
const DATA=path.isAbsolute(D0)?D0:path.join(ROOT,D0);
const LIMIT=+(process.env.LIMIT||0);

// A readable message instead of a stack trace: on a fresh clone
// there is no log yet, and that is a normal state, not a failure.
function needData(DATA){
  const mf=require('path').join(DATA,'meta.json');
  if(fs.existsSync(mf))return JSON.parse(fs.readFileSync(mf,'utf8'));
  console.error('No log found: '+mf);
  console.error('Collect events first:  node ingest/ingest.js');
  console.error('Or specify a directory: DATA=/path/to/data node '+
    require('path').basename(process.argv[1]));
  process.exit(3);
}
const meta=needData(DATA);
const E=loadEngine();
E.SIMC.GENESIS_TS=meta.genesisTs;
E.SIMC.STEP_MS=meta.stepMs||50;

// events from all shards, including the archive and all collectors
const evs=[];const seen=new Set();
function readDir(dir,rel){
  for(const f of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,f.name);
    if(f.isDirectory()){readDir(p,rel+f.name+'/');continue;}
    if(!f.name.endsWith('.csv'))continue;
    for(const l of fs.readFileSync(p,'utf8').split('\n')){
      if(!l||l[0]==='s')continue;
      const c=l.split(',');
      if(c.length<7||seen.has(c[6]))continue;
      seen.add(c[6]);
      evs.push({step:+c[0],ts:+c[1],side:+c[2],sol:+c[3],px:+c[4],blk:+c[5],sig:c[6]});
    }
  }
}
readDir(path.join(DATA,'events'),'');
evs.sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));

let cks=[];
for(const f of ['checkpoints-archive.jsonl','checkpoints.jsonl']){
  const p=path.join(DATA,f);
  if(!fs.existsSync(p))continue;
  for(const l of fs.readFileSync(p,'utf8').split('\n'))
    if(l.trim())try{cks.push(JSON.parse(l));}catch(e){}
}
cks.sort((a,b)=>a.step-b.step);
if(cks.length<2){
  console.log('fewer than two snapshots - nothing to verify the chain with');
  process.exit(0);
}
if(LIMIT&&cks.length>LIMIT)cks=cks.slice(-LIMIT-1);

console.log('events       :',evs.length.toLocaleString('en-US'));
console.log('snapshots    :',cks.length,`(steps ${cks[0].step}..${cks[cks.length-1].step})`);
console.log();

let ok=0,bad=0;
for(let i=0;i<cks.length-1;i++){
  const a=cks[i],b=cks[i+1];
  E.set(restore(E,a));
  let j=0;while(j<evs.length&&evs[j].step<=a.step-1)j++;
  for(let st=a.step;st<b.step;st++){
    while(j<evs.length&&evs[j].step<=st)E.simApplyEvent(evs[j++]);
    E.simStep();E.OUTQ.length=0;
  }
  const got=E.simHash();
  if(got===b.hash)ok++;
  else{
    bad++;
    if(bad<=5)console.log(`  BROKEN LINK  ${a.step} -> ${b.step}:`
      +` expected ${b.hash}, got ${got}`);
  }
}
console.log(`links intact : ${ok} of ${ok+bad}`);
if(bad)console.log(`BROKEN       : ${bad}`);
console.log();
console.log(bad?'VERIFICATION FAILED - log and snapshots do not match'
  :'VERIFICATION PASSED - every snapshot follows from the previous one via log events');
process.exit(bad?1:0);
