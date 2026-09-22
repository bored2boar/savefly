#!/usr/bin/env node
/* Rebuilds state snapshots from an existing event log.
   Needed if the collector ran without checkpoints or the log
   was moved from another machine. */
const fs=require('fs'),path=require('path');
const {loadEngine,snapshot}=require('./engine.js');
const ROOT=path.resolve(__dirname,'..');
const D0=process.env.DATA||'data';
const DATA=path.isAbsolute(D0)?D0:path.join(ROOT,D0);
const CK=+(process.env.CK_STEPS||6000);

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


// Shards may live in collector subdirectories (events/A/, events/B/)
// and in the archive. Read recursively and dedupe by signature.
function readEvents(root){
  const out=[],seen=new Set();
  (function walk(dir){
    if(!fs.existsSync(dir))return;
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const p=path.join(dir,e.name);
      if(e.isDirectory()){walk(p);continue;}
      if(!e.name.endsWith('.csv'))continue;
      for(const l of fs.readFileSync(p,'utf8').split('\n')){
        if(!l||l[0]==='s')continue;
        const c=l.split(',');
        if(c.length<7||seen.has(c[6]))continue;
        seen.add(c[6]);
        out.push({step:+c[0],ts:+c[1],side:+c[2],sol:+c[3],
          px:+c[4],blk:+c[5],sig:c[6]});
      }
    }
  })(root);
  out.sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));
  return out;
}
const evs=readEvents(path.join(DATA,'events'));

const S=E.simGenesis();
S.px=evs[0].px;S.pxAth=Math.max(meta.pxAth||0,S.px);
S.silk=Math.max(0,Math.min(1,1-S.px/S.pxAth));
E.set(S);

const last=evs[evs.length-1].step;
const out=[];let i=0,t0=Date.now();
for(let st=0;st<=last;st++){
  while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
  E.simStep();E.OUTQ.length=0;
  if(E.get().step%CK===0)out.push(JSON.stringify(snapshot(E.get(),E.simHash())));
}
// the final snapshot always, even if the step is not a multiple
const fin=JSON.stringify(snapshot(E.get(),E.simHash()));
out.push(fin);
fs.writeFileSync(path.join(DATA,'checkpoints.jsonl'),out.join('\n')+'\n');
fs.writeFileSync(path.join(DATA,'state.json'),fin+'\n');
meta.ckStep=E.get().step;meta.ckFile='checkpoints.jsonl';
meta.simStep=E.get().step;meta.simHash=E.simHash();
meta.silk=+E.get().silk.toFixed(6);meta.gen=E.get().gen;
fs.writeFileSync(path.join(DATA,'meta.json'),JSON.stringify(meta,null,2)+'\n');

console.log('events       :',evs.length);
console.log('steps        :',last.toLocaleString('en-US'));
console.log('snapshots    :',out.length,'(every',CK,'steps)');
console.log('state.json   :',fs.statSync(path.join(DATA,'state.json')).size,'bytes');
console.log('hash         :',E.simHash(),'@',E.get().step);
console.log('time         :',((Date.now()-t0)/1000).toFixed(1),'s');
