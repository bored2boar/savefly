#!/usr/bin/env node
/* Resilience to real launch conditions: client clock skew,
   an exception in a frame, an abandoned log. */
const {createCanvas}=require('canvas');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;
const T=(n,ok,i)=>{if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(i?'  -> '+i:''));}};

let FILES={};
const srv=http.createServer((req,res)=>{
  const p=decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//,'');
  const b=FILES[p];
  if(b===undefined||b===null){res.writeHead(404);return res.end('nf');}
  const sz=Buffer.byteLength(b),r=req.headers.range;
  if(r){const st=+(/bytes=(\d+)-/.exec(r)[1]);
    if(st>=sz){res.writeHead(416,{'Content-Range':`bytes */${sz}`});return res.end();}
    res.writeHead(206,{'Content-Range':`bytes ${st}-${sz-1}/${sz}`});return res.end(b.slice(st));}
  res.writeHead(200);res.end(b);
});
function shardNow(){const d=new Date(),p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}.csv`;}
function mkLog(n,metaExtra){
  const t0=Date.now()-1200000;
  const rows=[];let px=0.03;
  for(let i=0;i<n;i++){
    const ts=t0+Math.round(i/n*1150000);
    px=Math.max(1e-9,px*(1+(i%3?1:-1)*0.0009));
    rows.push([Math.floor((ts-t0)/50),ts,i%3?1:-1,0.7,px.toFixed(12),400000+i,'RB'+i].join(','));
  }
  const S=shardNow();
  FILES={['events/'+S]:'step,ts,side,sol,px,blk,sig\n'+rows.join('\n')+'\n',
    'meta.json':JSON.stringify(Object.assign({schema:2,pool:'TESTPOOL',network:'solana',
      stepMs:50,genesisTs:t0,pxAth:0.05,athSeeded:true,
      lastStep:Math.floor(1150000/50),rows:n,shards:['events/'+S],gaps:0,
      updated:Date.now()},metaExtra||{}))};
}
function client(runMs,skewMs,patch){
  return new Promise(res=>{
    let src=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
      .split('<script>')[1].split('</script>')[0];
    src=src.replace("  mode:      'demo',","  mode:      'csv',");
    src=src.replace("  dataUrl:   'data/',","  dataUrl:   'http://localhost:8155/data/',");
    src=src.replace("  pollMs:    4000,","  pollMs:    900,");
    if(patch)src=patch(src);
    src+="\nG.__p=()=>({mode:FEEDCFG.mode,step:S.step,silk:S.silk,ev:S.evCount,"
       +"ck:S.ckHash,ckStep:S.ckStep,ckLog:S.ckLog,health:FEED.health().s,"
       +"errs:(typeof loopErrs!=='undefined'?loopErrs:-1),maxStep:FEED.maxStep,"
       +"pool:FEED.pool,seed:S.seed});";
    src=src.replace(/globalThis\./g,'G.');
    const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
    const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
    const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
    function mkEl(){const c=createCanvas(1,1);c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};c.textContent='';c.innerHTML='';c.className='';c.value=50;c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};c.appendChild=()=>{};c.requestFullscreen=()=>{};c.dataset={};c.onclick=null;return c}
    const store={};
    const doc={getElementById(id){if(!store[id])store[id]=mkEl();return store[id]},createElement(){return mkEl()},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
    let done=false;const G={};
    const raf=(cb)=>{if(!done)setTimeout(()=>cb(Date.now()+skewMs),6)};
    // swap out the client clock
    const realNow=Date.now;
    const fakeNow=()=>realNow()+skewMs;
    let err=null;
    try{
      Date.now=fakeNow;
      new Function('document','window','AudioContext','requestAnimationFrame','fetch','G','console',src)
        (doc,{AudioContext:AC},AC,raf,fetch,G,{error(){},warn(){},log(){}});
    }catch(e){err=e.message;}
    finally{Date.now=realNow;}
    setTimeout(()=>{done=true;res({p:G.__p?G.__p():null,err});},runMs);
  });
}
(async()=>{
  await new Promise(r=>srv.listen(8155,r));
  mkLog(400);

  // 1. clock skew: clients must converge
  const runs=[];
  for(const skew of [0,-600000,600000,-60000]){
    runs.push(await client(6000,skew));
  }
  const maps=runs.filter(r=>r.p&&r.p.ckLog&&r.p.ckLog.length).map(r=>{
    const m=new Map();
    for(const e of r.p.ckLog){const i=e.indexOf(':');m.set(+e.slice(0,i),e.slice(i+1));}
    return m;});
  let common=maps.length?[...maps[0].keys()]:[];
  for(let i=1;i<maps.length;i++)common=common.filter(k=>maps[i].has(k));
  let bad=0;
  for(const st of common){
    const hs=maps.map(m=>m.get(st));
    if(hs.some(x=>x!==hs[0]))bad++;
  }
  T('clock skew ±10min -> same state',
    maps.length===4&&common.length>0&&bad===0,
    `clients ${maps.length}, shared ${common.length}, diverging ${bad}`);

  // 2. an exception in a frame does not freeze the loop
  {
    const r=await client(5000,0,(s)=>s.replace("function drawVig(){",
      "let _boom=0;\nfunction drawVig(){if(++_boom===40)throw new Error('deliberate failure');"));
    T('exception in a frame does not freeze the loop',
      r.p&&r.p.errs>=1&&r.p.step>0&&isFinite(r.p.silk),
      r.p?('errs='+r.p.errs+' step='+r.p.step):'no state');
  }
  // 3. abandoned log: files exist, collector is dead
  {
    mkLog(400,{updated:Date.now()-3600000});
    const r=await client(5000,0);
    T('abandoned log is detected',
      r.p&&(r.p.health==='stale'),r.p&&('health='+r.p.health));
  }
  // 4. genesis seed is derived from the pool
  {
    mkLog(400);
    const r=await client(5000,0);
    T('seed derived from the pool address',
      r.p&&r.p.seed!==0x5A4EF1&&r.p.pool==='TESTPOOL',
      r.p&&('seed=0x'+(r.p.seed>>>0).toString(16)+' pool='+r.p.pool));
  }
  console.log();
  console.log(`RESULT: ${pass} pass, ${fail} fail`);
  srv.close();process.exit(fail?1:0);
})();
