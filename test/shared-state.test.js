#!/usr/bin/env node
/* The core invariant of the project: clients reading the same log
   converge to a bit-identical state - regardless of FPS and of
   when they joined. */
const {spawn}=require('child_process'),path=require('path');
const URL=process.env.DATA_URL||'http://localhost:8099/data/';
const runner=path.join(__dirname,'_client.js');

function client(name,env,delay){
  return new Promise(res=>setTimeout(()=>{
    const p=spawn(process.execPath,[runner],
      {env:Object.assign({},process.env,{DATA_URL:URL},env)});
    let out='';
    p.stdout.on('data',d=>out+=d);
    p.on('close',()=>{
      let j=null;try{j=JSON.parse(out.trim().split('\n').pop());}catch(e){}
      res({name,j});
    });
  },delay));
}
(async()=>{
  console.log('log:',URL);
  console.log();
  const runs=await Promise.all([
    client('A  60fps join 0s', {FSTEP:16,RUNMS:26000},0),
    client('B  30fps join 0s', {FSTEP:33,RUNMS:26000},0),
    client('C 120fps join 0s', {FSTEP:8, RUNMS:26000},0),
    client('D  60fps join 9s', {FSTEP:16,RUNMS:17000},9000),
  ]);
  let ok=true;
  const maps=[];
  for(const r of runs){
    const p=r.j;
    if(!p||p.err){console.log(`  ${r.name.padEnd(18)} ERROR: ${p&&p.err||'no state'}`);ok=false;continue;}
    console.log(`  ${r.name.padEnd(18)} ck=${p.ck} @${String(p.ckStep).padEnd(7)}`
      +` gen=${p.gen} silk=${p.silk.toFixed(6)} k/b=${p.kills}/${p.bites}`
      +` ev=${p.ev} shared=${p.shared} applied=${p.stats.applied} late=${p.stats.late}`);
    const m=new Map();
    for(const e of (p.ckLog||[])){const i=e.indexOf(':');m.set(+e.slice(0,i),e.slice(i+1));}
    maps.push({name:r.name,m});
  }
  // match on steps everyone saw: a client may lag behind,
  // but on a shared step the hash must match
  if(maps.length>1){
    let common=[...maps[0].m.keys()];
    for(let i=1;i<maps.length;i++)common=common.filter(k=>maps[i].m.has(k));
    common.sort((a,b)=>a-b);
    console.log();
    console.log(`  shared checkpoints: ${common.length}`);
    let bad=0;
    for(const st of common){
      const hs=maps.map(x=>x.m.get(st));
      if(hs.some(h=>h!==hs[0])){bad++;
        if(bad<4)console.log(`    step ${st}: ${hs.join(' / ')}`);}
    }
    if(!common.length){console.log('    no overlap - test invalid');ok=false;}
    else if(bad){console.log(`    diverging: ${bad}`);ok=false;}
    else console.log(`    all match, from ${common[0]} to ${common[common.length-1]}`);
  }
  console.log();
  console.log(ok?'PASS  all clients in the same state':'FAIL  divergence');
  process.exit(ok?0:1);
})();
