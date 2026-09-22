const {createCanvas}=require('canvas');
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT='/home/claude/savefly';
let pass=0,fail=0;
function T(n,ok,info){if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(info?'  -> '+info:''));}}
// a server we can break in a controlled way
let MODE='ok',FILES={};
const srv=http.createServer((req,res)=>{
  const p=decodeURIComponent(req.url.split('?')[0]).replace(/^\/data\//,'');
  if(MODE==='dead'){res.writeHead(500);return res.end('x');}
  if(FILES[p]===null){res.writeHead(404);return res.end('nf');}
  if(FILES[p]!==undefined){
    const body=FILES[p];
    if(MODE==='norange'){res.writeHead(200,{'Content-Length':Buffer.byteLength(body)});return res.end(body);}
    const r=req.headers.range;
    if(r){const st=+(/bytes=(\d+)-/.exec(r)[1]);const sz=Buffer.byteLength(body);
      if(st>=sz){res.writeHead(416,{'Content-Range':`bytes */${sz}`});return res.end();}
      res.writeHead(206,{'Content-Range':`bytes ${st}-${sz-1}/${sz}`});return res.end(body.slice(st));}
    res.writeHead(200);return res.end(body);
  }
  res.writeHead(404);res.end('nf');
});
function shard(){const d=new Date(),p=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}.csv`;}
function csv(rows){return 'step,ts,side,sol,px,blk,sig\n'+rows.join('\n')+'\n';}
function client(label,timeoutMs){
  return new Promise(res=>{
    let src=fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
      .split('<script>')[1].split('</script>')[0];
    src=src.replace("  mode:      'demo',","  mode:      'csv',");
    src=src.replace("  dataUrl:   'data/',","  dataUrl:   'http://localhost:8122/data/',");
    src=src.replace("  pollMs:    4000,","  pollMs:    1200,");
    src+="\nglobalThis.__p=()=>({mode:FEEDCFG.mode,state:FEED.state,shared:FEED.shared,"
       +"step:S.step,silk:S.silk,gen:S.gen,ev:S.evCount,boot:booting,sy:syncing,"
       +"stats:FEED.stats,px:S.px,pxAth:S.pxAth,health:FEED.health().s,hash:simHash()});";
    const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
    const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
    global.AudioContext=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
    function mkEl(){const c=createCanvas(1,1);c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};c.textContent='';c.innerHTML='';c.className='';c.value=50;c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};c.appendChild=()=>{};c.requestFullscreen=()=>{};return c}
    const store={};
    const doc={getElementById(id){if(!store[id])store[id]=mkEl();return store[id]},createElement(){return mkEl()},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
    let done=false;
    const g={};
    const fn=new Function('document','window','AudioContext','requestAnimationFrame','fetch','G',
      src.replace(/globalThis\./g,'G.'));
    const raf=(cb)=>{if(!done)setTimeout(()=>cb(Date.now()),6)};
    let err=null;
    try{fn(doc,{AudioContext:global.AudioContext},global.AudioContext,raf,fetch,g);}
    catch(e){err=e.message;}
    setTimeout(()=>{done=true;res({label,p:g.__p?g.__p():null,err});},timeoutMs||5000);
  });
}
(async()=>{
  await new Promise(r=>srv.listen(8122,r));
  const S=shard();

  // C12 meta missing
  FILES={};MODE='ok';
  let r=await client('C12');
  T('C12 meta.json missing -> falls back to demo',r.p&&r.p.mode==='demo',r.p&&r.p.mode);

  // C12b meta corrupted
  FILES={'meta.json':'{ this is not json'};
  r=await client('C12b');
  T('C12b meta.json corrupted -> demo',r.p&&r.p.mode==='demo',r.p&&r.p.mode);

  // C1 empty log
  FILES={'meta.json':JSON.stringify({genesisTs:Date.now()-600000,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv([])};
  r=await client('C1');
  T('C1 empty log -> demo, no crash',r.p&&!r.err,r.err);

  // C2 one event
  const t0=Date.now()-600000;
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv([`0,${t0},-1,1.5,0.03,1,AAA`])};
  r=await client('C2');
  T('C2 one event -> csv works',r.p&&r.p.mode==='csv'&&r.p.ev>=1,r.p&&(r.p.mode+' ev='+r.p.ev));

  // C6 corrupted rows among normal ones
  const rows=[];
  for(let i=0;i<60;i++)rows.push(`${i*20},${t0+i*1000},${i%2?1:-1},0.6,0.03,${i},S${i}`);
  rows.splice(10,0,'truncated,row');
  rows.splice(20,0,'5,notanumber,-1,abc,NaN,x,SIGX');
  rows.splice(30,0,'');
  rows.splice(40,0,'1,2,3,4,5,6,7,8,9,10,11');
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(rows)};
  r=await client('C6');
  T('C6 corrupted rows -> skipped',r.p&&r.p.mode==='csv'&&r.p.ev>40&&isFinite(r.p.silk),
    r.p&&(r.p.mode+' ev='+r.p.ev+' silk='+r.p.silk));

  // C5 duplicate signatures
  const dup=[];for(let i=0;i<40;i++)dup.push(`${i*20},${t0+i*1000},-1,0.8,0.03,${i},DUP`);
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(dup)};
  r=await client('C5');
  T('C5 40 identical signatures -> one event',r.p&&r.p.ev===1,r.p&&('ev='+r.p.ev));

  // C11 shard vanished
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S,'2020-01-01T00.csv']}),
         ['events/'+S]:csv(rows),'events/2020-01-01T00.csv':null};
  r=await client('C11');
  T('C11 shard from meta missing -> no crash',r.p&&!r.err&&r.p.mode==='csv',r.err||(r.p&&r.p.mode));

  // C14 server without Range
  MODE='norange';
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(rows)};
  r=await client('C14',6000);
  T('C14 server without Range -> fallback path',r.p&&r.p.mode==='csv'&&r.p.ev>40,
    r.p&&(r.p.mode+' ev='+r.p.ev));
  MODE='ok';

  // C13 state.json from another pool (step far in the future)
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(rows),
         'state.json':JSON.stringify({step:999999999,gen:77,px:123,pxAth:456,
           silk:0.5,debt:0,kills:1,bites:1,spiders:[],shots:[],hash:'deadbeef'})};
  r=await client('C13',6000);
  T('C13 foreign state.json -> does not break state',
    r.p&&isFinite(r.p.silk)&&r.p.silk>=0&&r.p.silk<=1.06,r.p&&('silk='+r.p.silk+' step='+r.p.step));
  T('C13b foreign state.json -> rejected, not accepted',
    r.p&&r.p.gen!==77&&r.p.step<1e8,r.p&&('gen='+r.p.gen+' step='+r.p.step+' px='+r.p.px));

  // C10 gap in the log
  const gap=[];
  for(let i=0;i<30;i++)gap.push(`${i*20},${t0+i*1000},${i%2?1:-1},0.6,0.03,${i},G${i}`);
  for(let i=0;i<30;i++)gap.push(`${6000+i*20},${t0+300000+i*1000},${i%2?1:-1},0.6,0.028,${100+i},H${i}`);
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(gap)};
  r=await client('C10',6000);
  T('C10 5 min gap -> state intact',r.p&&isFinite(r.p.silk)&&r.p.ev>50,
    r.p&&('ev='+r.p.ev+' silk='+r.p.silk));

  // C15 404 on the current hour
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:['2026-01-01T00.csv']}),
         'events/2026-01-01T00.csv':csv(rows),['events/'+S]:null};
  r=await client('C15',6000);
  T('C15 current hour 404 -> not an error',r.p&&r.p.mode==='csv'&&!r.err,r.err||(r.p&&r.p.mode));

  // feed died mid-run
  FILES={'meta.json':JSON.stringify({genesisTs:t0,pxAth:0.03,stepMs:50,shards:[S]}),
         ['events/'+S]:csv(rows)};
  const pr=client('dead',7000);
  setTimeout(()=>{MODE='dead';},2500);
  r=await pr;MODE='ok';
  T('feed died -> state not broken',r.p&&isFinite(r.p.silk)&&r.p.mode==='csv',
    r.p&&(r.p.mode+' health='+r.p.health));

  console.log();
  console.log(`RESULT: ${pass} pass, ${fail} fail`);
  srv.close();process.exit(fail?1:0);
})();
