#!/usr/bin/env node
/* Many clients on one static server.
   We measure: requests/s, bytes per client, and most importantly -
   whether they all converged to the same state. */
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const N=+(process.env.N||24);
const RUNMS=+(process.env.RUNMS||16000);
const ROOT=path.resolve(__dirname,'..');
const DATA=process.env.DATA||path.join(ROOT,'data');
const PORT=8144;
let reqs=0,bytes=0,r206=0,r416=0,r404=0,byPath={};
const srv=http.createServer((req,res)=>{
  const p=decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//,'');
  const f=path.join(DATA,p);
  reqs++;byPath[p]=(byPath[p]||0)+1;
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r404++;res.writeHead(404);return res.end('nf');}
  const size=fs.statSync(f).size,range=req.headers.range;
  if(range){
    const st=+(/bytes=(\d+)-/.exec(range)[1]);
    if(st>=size){r416++;res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
    r206++;bytes+=size-st;
    res.writeHead(206,{'Content-Range':`bytes ${st}-${size-1}/${size}`,
      'Content-Length':size-st,'Accept-Ranges':'bytes'});
    return fs.createReadStream(f,{start:st}).pipe(res);
  }
  bytes+=size;
  res.writeHead(200,{'Content-Length':size,'Accept-Ranges':'bytes'});
  fs.createReadStream(f).pipe(res);
});
const runner=path.join(__dirname,'_client.js');
function client(i){
  return new Promise(res=>{
    const delay=Math.floor(Math.random()*4000);
    setTimeout(()=>{
      const p=spawn(process.execPath,[runner],{env:Object.assign({},process.env,{
        DATA_URL:`http://localhost:${PORT}/data/`,
        FSTEP:String([8,16,33,50][i%4]),
        RUNMS:String(RUNMS-delay),
        POLL:String(2500+((i*137)%2000))})});
      let out='';
      p.stdout.on('data',d=>out+=d);
      p.on('close',()=>{let j=null;
        try{j=JSON.parse(out.trim().split('\n').pop());}catch(e){}
        res({i,delay,j});});
    },delay);
  });
}
(async()=>{
  await new Promise(r=>srv.listen(PORT,r));
  const T0=Date.now();
  const rs=await Promise.all(Array.from({length:N},(_,i)=>client(i)));
  const wall=(Date.now()-T0)/1000;
  const good=rs.filter(r=>r.j&&!r.j.err);
  const maps=[];
  for(const r of good){
    const m=new Map();
    for(const e of (r.j.ckLog||[])){const k=e.indexOf(':');m.set(+e.slice(0,k),e.slice(k+1));}
    if(m.size)maps.push({i:r.i,m});
  }
  if(process.env.DIAG){
    for(const r of good.slice(0,8)){
      const L=r.j.ckLog||[];
      console.log(`   #${String(r.i).padStart(2)} delay ${String(r.delay).padStart(4)}ms`
        +` points ${String(L.length).padStart(3)}`
        +` window ${L.length?L[0].split(':')[0]+'..'+L[L.length-1].split(':')[0]:'-'}`
        +` step ${r.j.step} ev ${r.j.ev} applied ${r.j.stats.applied}`);
    }
  }
  let common=maps.length?[...maps[0].m.keys()]:[];
  for(let i=1;i<maps.length;i++)common=common.filter(k=>maps[i].m.has(k));
  common.sort((a,b)=>a-b);
  let bad=0;
  for(const st of common){
    const hs=maps.map(x=>x.m.get(st));
    if(hs.some(h=>h!==hs[0]))bad++;
  }
  const top=Object.entries(byPath).sort((a,b)=>b[1]-a[1]).slice(0,4);
  console.log();
  console.log(`  clients           : ${N} (ok ${good.length})`);
  console.log(`  duration          : ${wall.toFixed(1)} s`);
  console.log(`  requests          : ${reqs} (${(reqs/wall).toFixed(1)}/s, ${(reqs/N).toFixed(1)} per client)`);
  console.log(`  traffic           : ${(bytes/1024).toFixed(0)} KB (${(bytes/1024/N).toFixed(1)} KB per client)`);
  console.log(`  206 / 416 / 404   : ${r206} / ${r416} / ${r404}`);
  console.log(`  hottest           : ${top.map(([p,n])=>p.replace('events/','')+' x'+n).join(', ')}`);
  console.log(`  shared points     : ${common.length}`);
  console.log(`  diverging         : ${bad}`);
  const ok=good.length===N&&common.length>0&&bad===0;
  console.log();
  console.log(ok?`  PASS  all ${N} clients in the same state`
    :`  FAIL  ${good.length}/${N} alive, ${bad} diverging points, ${common.length} shared`);
  srv.close();process.exit(ok?0:1);
})();
