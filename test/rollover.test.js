#!/usr/bin/env node
/* Shard rotation: by size and by hour. The trickiest part -
   whether the client finds the tail after the collector has moved
   on to the next file. */
const {createCanvas}=require('canvas');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
let pass=0,fail=0;
function T(n,ok,info){if(ok){pass++;console.log('  PASS  '+n);}
  else{fail++;console.log('  FAIL  '+n+(info?'  -> '+info:''));}}

let FILES={};
const srv=http.createServer((req,res)=>{
  const p=decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//,'');
  const body=FILES[p];
  if(body===undefined||body===null){res.writeHead(404);return res.end('nf');}
  const sz=Buffer.byteLength(body),r=req.headers.range;
  if(r){const st=+(/bytes=(\d+)-/.exec(r)[1]);
    if(st>=sz){res.writeHead(416,{'Content-Range':`bytes */${sz}`});return res.end();}
    res.writeHead(206,{'Content-Range':`bytes ${st}-${sz-1}/${sz}`});
    return res.end(body.slice(st));}
  res.writeHead(200);res.end(body);
});
function hourBase(off){
  const d=new Date(Date.now()+(off||0));
  const p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}`;
}
function csv(rows){return 'step,ts,side,sol,px,blk,sig\n'+(rows.length?rows.join('\n')+'\n':'');}
function rows(n,fromStep,t0,tag){
  const o=[];for(let i=0;i<n;i++)
    o.push(`${fromStep+i*20},${t0+i*1000},${i%2?1:-1},0.7,0.03,${i},${tag}${i}`);
  return o;}

function client(runMs,onTick){
  return new Promise(res=>{
    let src=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
      .split('<script>')[1].split('</script>')[0];
    src=src.replace("  mode:      'demo',","  mode:      'csv',");
    src=src.replace("  dataUrl:   'data/',","  dataUrl:   'http://localhost:8133/data/',");
    src=src.replace("  pollMs:    4000,","  pollMs:    600,");
    src+="\nG.__p=()=>({mode:FEEDCFG.mode,ev:S.evCount,step:S.step,shard:FEED.csv.shard,"
       +"off:FEED.csv.off,stats:FEED.stats,silk:S.silk,health:FEED.health().s});";
    src=src.replace(/globalThis\./g,'G.');
    const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
    const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
    const AC=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
    function mkEl(){const c=createCanvas(1,1);c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};c.textContent='';c.innerHTML='';c.className='';c.value=50;c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};c.appendChild=()=>{};c.requestFullscreen=()=>{};return c}
    const store={};
    const doc={getElementById(id){if(!store[id])store[id]=mkEl();return store[id]},createElement(){return mkEl()},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
    let done=false;const G={};
    const raf=(cb)=>{if(!done)setTimeout(()=>cb(Date.now()),6)};
    let err=null;
    try{new Function('document','window','AudioContext','requestAnimationFrame','fetch','G',src)
      (doc,{AudioContext:AC},AC,raf,fetch,G);}catch(e){err=e.message;}
    if(onTick)setTimeout(()=>onTick(G),Math.floor(runMs*0.45));
    setTimeout(()=>{done=true;res({p:G.__p?G.__p():null,err});},runMs);
  });
}
(async()=>{
  await new Promise(r=>srv.listen(8133,r));
  const t0=Date.now()-1200000;
// tail events are fresh, otherwise they are legitimately dropped as late
const tLive=Date.now()-90000;
const sLive=Math.floor((tLive-t0)/50);
  const B=hourBase();

  // 1. base case: one shard without a suffix
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[B+'.csv']}),
         ['events/'+B+'.csv']:csv(rows(40,0,t0,'A'))};
  let r=await client(4500);
  T('base shard without suffix',r.p&&r.p.ev>=35,r.p&&('ev='+r.p.ev));

  // 2. shard with a size suffix - what the collector writes after 4 MB
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,
           shards:[B+'.csv',B+'.1.csv']}),
         ['events/'+B+'.csv']:csv(rows(40,0,t0,'A')),
         ['events/'+B+'.1.csv']:csv(rows(40,sLive,tLive,'B'))};
  r=await client(5000);
  T('shard with .1 suffix is read',r.p&&r.p.ev>=70,r.p&&('ev='+r.p.ev+' shard='+r.p.shard));

  // 3. rotation MID-run: the collector moved to .1, the client must pick it up
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[B+'.csv']}),
         ['events/'+B+'.csv']:csv(rows(40,0,t0,'A'))};
  r=await client(7000,(G)=>{
    FILES['events/'+B+'.1.csv']=csv(rows(40,sLive,tLive,'B'));
    FILES['meta.json']=JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,
      shards:[B+'.csv',B+'.1.csv']});
  });
  T('size rotation mid-run',r.p&&r.p.ev>=70,
    r.p&&('ev='+r.p.ev+' shard='+r.p.shard+' late='+r.p.stats.late));

  // 4. hour rollover mid-run
  const B2=hourBase(3600000);
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[B+'.csv']}),
         ['events/'+B+'.csv']:csv(rows(40,0,t0,'A'))};
  r=await client(7000,(G)=>{
    FILES['events/'+B2+'.csv']=csv(rows(40,sLive,tLive,'C'));
    FILES['meta.json']=JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,
      shards:[B+'.csv',B2+'.csv']});
  });
  T('hour rollover mid-run',r.p&&r.p.ev>=70,
    r.p&&('ev='+r.p.ev+' shard='+r.p.shard+' late='+r.p.stats.late));

  console.log();
  console.log(`RESULT: ${pass} pass, ${fail} fail`);
  srv.close();process.exit(fail?1:0);
})();
