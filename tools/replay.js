#!/usr/bin/env node
/* Independent replay: takes the CSV log, runs it through the engine
   and prints the state. Anyone can check that the picture shown
   is derived from exactly these events, not drawn. */
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
const D0=process.env.DATA||'data';
const DATA=path.isAbsolute(D0)?D0:path.join(ROOT,D0);

let js=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0];
const a=js.indexOf('const SIMC={'), b=js.indexOf('/* ── FEED LAYER');
const STUB=`const RW=320,RH=224;
const WEB={cx:160,cy:96,spokes:12,rings:6};const SPOKE=[];
for(let i=0;i<12;i++)SPOKE.push({a:i/12*6.28319,len:100+(i%5)*9,sag:.06+(i%4)*.02,vib:0});
function cl(v,x,y){return v<x?x:(v>y?y:v);}
function spokeStatic(i,t){const s=SPOKE[i],r=s.len*t;
  return[WEB.cx+Math.cos(s.a)*r,WEB.cy+Math.sin(s.a)*r+Math.sin(t*Math.PI)*s.len*s.sag*.30];}`;
const E={};
(new Function('exp',STUB+js.slice(a,b)+`
  exp.SIMC=SIMC;exp.simGenesis=simGenesis;exp.simStep=simStep;
  exp.simApplyEvent=simApplyEvent;exp.simHash=simHash;exp.OUTQ=OUTQ;
  exp.set=(v)=>{S=v;};exp.get=()=>S;`))(E);

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
if(!evs.length){console.log('log is empty');process.exit(1);}

const S=E.simGenesis();
S.px=evs[0].px;S.pxAth=Math.max(meta.pxAth||0,S.px);
S.silk=Math.max(0,Math.min(1,1-S.px/S.pxAth));
E.set(S);

const last=evs[evs.length-1].step;
const marks=[];
let i=0,deaths=0;
for(let st=0;st<=last;st++){
  while(i<evs.length&&evs[i].step<=st)E.simApplyEvent(evs[i++]);
  const wd=E.get().dead;
  E.simStep();E.OUTQ.length=0;
  if(!wd&&E.get().dead)deaths++;
  if(st%20===0&&marks.length<64)marks.push(st+':'+E.simHash());
}
const s=E.get();
console.log('log         :',evs.length,'events,',path.relative(ROOT,DATA));
console.log('genesis     :',new Date(meta.genesisTs).toISOString());
console.log('steps       :',last.toLocaleString('en-US'));
console.log('price / ATH :',s.px,'/',s.pxAth);
console.log('drawdown    :',((1-s.px/s.pxAth)*100).toFixed(2)+'%');
console.log('silk        :',s.silk.toFixed(6),' debt:',s.debt.toFixed(6));
console.log('intercept   :',s.kills+'/'+(s.kills+s.bites),
  '('+(s.kills/Math.max(1,s.kills+s.bites)*100).toFixed(0)+'%)');
console.log('generations :',s.gen,' deaths:',deaths);
console.log('STATE HASH  :',E.simHash(),'@',s.step);
if(process.env.MARKS)console.log('first points:',marks.slice(0,8).join(' '));
