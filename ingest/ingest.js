#!/usr/bin/env node
/* Event collector: polls the provider and appends the canonical log to CSV.
   One process per pool. Clients read static files - nobody else hits the
   provider, rate limits are safe, everyone has the same state. */
const fs=require('fs'),path=require('path');
const {loadEngine,snapshot}=require('../tools/engine.js');
const {RpcSource}=require('./rpc-source.js');

const CFG=JSON.parse(fs.readFileSync(
  process.env.CFG||path.join(__dirname,'config.json'),'utf8'));
const D0=CFG.dataDir||'data';
const DATA=path.isAbsolute(D0)?D0:path.resolve(__dirname,'..',D0);
/* Redundancy without locks: each collector writes to its own
   subdirectory events/<writer>/. The client reads all of them, dedupes by sig
   and sorts by canonical order (step, blk, sig) - the result is
   the same regardless of how many collectors run and when
   any of them went down. One's downtime is covered by another. */
const WRITER=String(CFG.writer||process.env.WRITER||'').trim();
const EVDIR=WRITER?path.join(DATA,'events',WRITER):path.join(DATA,'events');
const EVREL=WRITER?('events/'+WRITER+'/'):'events/';
fs.mkdirSync(EVDIR,{recursive:true});

const EV_HEAD='step,ts,side,sol,px,blk,sig';
const DT_HEAD='gen,step,ts,seed,name,title,ageSteps,kills,bites,px,pxAth,lastSig';
const seen=new Set();
// The collector runs the same simulation and writes state snapshots. The client
// starts from the latest snapshot instead of replaying the log from genesis:
// a week-long log is 12M steps and 30 seconds of CPU.
const E=loadEngine();
let simReady=false;
let state={genesisTs:0,pxAth:0,athSeeded:false,lastStep:-1,rows:0,polls:0,errs:0};

// Shard = one hour, but capped by size: on a hot launch
// an hour can produce tens of MB, and then one file breaks resumption.
// The suffix counts within the hour. Without tying it to base a new hour
// started with an inherited number (T11.2 instead of T11), and the client
// could not find the tail.
let shardSeq=0,shardBase='';
function shardFor(tsMs){
  const d=new Date(tsMs),p=(n)=>String(n).padStart(2,'0');
  const base=`${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`
        +`T${p(d.getUTCHours())}`;
  if(base!==shardBase){shardBase=base;shardSeq=0;}
  const cap=(CFG.shardMaxMB||4)*1024*1024;
  let seq=shardSeq,f=path.join(EVDIR,base+(seq?'.'+seq:'')+'.csv');
  while(fs.existsSync(f)&&fs.statSync(f).size>=cap){
    seq++;f=path.join(EVDIR,base+'.'+seq+'.csv');
  }
  shardSeq=seq;
  return base+(seq?'.'+seq:'')+'.csv';
}
function appendRows(rows){
  const by=new Map();
  for(const r of rows){
    const s=shardFor(r.ts);
    if(!by.has(s))by.set(s,[]);
    by.get(s).push(r);
  }
  for(const [shard,rs] of by){
    const f=path.join(EVDIR,shard);
    const fresh=!fs.existsSync(f);
    const body=rs.map(r=>[r.step,r.ts,r.side,r.sol,r.px,r.blk,r.sig].join(','))
      .join('\n')+'\n';
    fs.appendFileSync(f,(fresh?EV_HEAD+'\n':'')+body);
  }
}
function shardKey(n){
  const m=/^(.+?T\d\d)(?:\.(\d+))?\.csv$/.exec(n);
  return m?[m[1],m[2]?+m[2]:0]:[n,0];
}
function shardCmp(a,b){
  const ka=shardKey(a),kb=shardKey(b);
  return ka[0]<kb[0]?-1:(ka[0]>kb[0]?1:ka[1]-kb[1]);
}
function ckPath(){return path.join(DATA,'checkpoints.jsonl');}
// a separate file per collector: otherwise two collectors would duplicate rows
function dtPath(){
  return path.join(DATA,WRITER?('deaths-'+WRITER+'.csv'):'deaths.csv');
}
/* Death registry. Append-only, with the signature of the last trade before
   the death - so every row is tied to a specific transaction
   on chain, and can be verified by replaying the log.
   This is not a contract record, and it must not be called one. */
function recordDeath(ev,lastSig){
  const d=E.mkDNA?E.mkDNA(ev.seed):null;
  const q=(v)=>String(v===undefined||v===null?'':v).replace(/[",\n]/g,' ');
  const row=[ev.gen,ev.step,ev.ts,'0x'+(ev.seed>>>0).toString(16),
    q(d&&d.name),q(d&&d.title),ev.ageSteps,ev.kills,ev.bites,
    ev.px,ev.pxAth,lastSig||''].join(',');
  const fresh=!fs.existsSync(dtPath());
  fs.appendFileSync(dtPath(),(fresh?DT_HEAD+'\n':'')+row+'\n');
  state.deaths=(state.deaths||0)+1;
  console.log(`[death] gen ${ev.gen} "${q(d&&d.name)}" step ${ev.step}`
    +` age ${Math.round(ev.ageSteps*CFG.stepMs/60000)}min`
    +` k/b ${ev.kills}/${ev.bites}`);
}
function advanceSim(fresh){
  if(!simReady){
    // the same seed derivation as the client: the DNA is tied to the pool
    if(E.seedFromString)E.SIMC.GENESIS_SEED=E.seedFromString(String(CFG.pool));
    const S=E.simGenesis();
    E.SIMC.GENESIS_TS=state.genesisTs;
    S.px=fresh[0].px||state.pxAth;
    S.pxAth=Math.max(state.pxAth,S.px);
    S.silk=Math.max(0,Math.min(1,1-S.px/S.pxAth));
    E.set(S);simReady=true;
  }
  const S=E.get();
  const target=fresh[fresh.length-1].step;
  let i=0,lastSig='';
  const CK=CFG.ckSteps||6000;
  for(let st=S.step;st<=target;st++){
    while(i<fresh.length&&fresh[i].step<=st){lastSig=fresh[i].sig;E.simApplyEvent(fresh[i++]);}
    E.simStep();
    for(const o of E.OUTQ)if(o.t==='death')
      recordDeath({gen:o.gen,seed:o.seed,step:E.get().step,
        ts:state.genesisTs+E.get().step*CFG.stepMs,
        ageSteps:o.ageSteps,kills:o.kills,bites:o.bites,
        px:E.get().px,pxAth:E.get().pxAth},lastSig);
    E.OUTQ.length=0;
    if(E.get().step%CK===0){
      const snap=JSON.stringify(snapshot(E.get(),E.simHash()));
      // snapshot log - for verification and archive, grows forever
      fs.appendFileSync(ckPath(),snap+'\n');
      // head - what the client reads: one file of a few kilobytes
      fs.writeFileSync(path.join(DATA,'state.json'),snap+'\n');
      state.ckStep=E.get().step;
    }
  }
  state.simStep=E.get().step;
  state.simHash=E.simHash();
  state.silk=+E.get().silk.toFixed(6);
  state.gen=E.get().gen;
}
/* Archiving. The client only needs the snapshot and the tail, so the active
   set of shards is bounded. Old ones move to events/archive/ -
   they do not disappear from disk (the log is append-only and verifiable), but
   they leave meta.shards so the client does not download them. */
function rotate(){
  const keep=CFG.keepShards||24;
  const files=fs.readdirSync(EVDIR).filter(f=>f.endsWith('.csv')).sort(shardCmp);
  if(files.length<=keep)return 0;
  const arc=path.join(EVDIR,'archive');
  fs.mkdirSync(arc,{recursive:true});
  let n=0;
  for(const f of files.slice(0,files.length-keep)){
    try{fs.renameSync(path.join(EVDIR,f),path.join(arc,f));n++;}catch(e){}
  }
  if(n)console.log(`[rotate] ${n} shards archived (keeping ${keep})`);
  return n;
}
function rotateCk(){
  const keep=CFG.keepCheckpoints||400;
  if(!fs.existsSync(ckPath()))return;
  const lines=fs.readFileSync(ckPath(),'utf8').split('\n').filter(Boolean);
  if(lines.length<=keep*2)return;
  const cut=lines.length-keep;
  fs.appendFileSync(path.join(DATA,'checkpoints-archive.jsonl'),
    lines.slice(0,cut).join('\n')+'\n');
  fs.writeFileSync(ckPath(),lines.slice(cut).join('\n')+'\n');
  console.log(`[rotate] ${cut} snapshots archived`);
}
function writeMeta(){
  // Lexicographic sorting puts T10.1.csv before T10.csv,
  // and the client would take the wrong file as the tail. Sort by (hour, number).
  // meta merges the shards of all collectors, not just its own
  const root=path.join(DATA,'events');
  rotate();rotateCk();
  const mine=fs.readdirSync(EVDIR).filter(f=>f.endsWith('.csv'))
    .sort(shardCmp).map(f=>EVREL+f);
  let all=mine.slice();
  try{
    for(const d of fs.readdirSync(root,{withFileTypes:true})){
      if(!d.isDirectory()||d.name===WRITER)continue;
      const sub=fs.readdirSync(path.join(root,d.name))
        .filter(f=>f.endsWith('.csv')).sort(shardCmp)
        .map(f=>'events/'+d.name+'/'+f);
      all=all.concat(sub);
    }
    if(WRITER)for(const f of fs.readdirSync(root))
      if(f.endsWith('.csv'))all.push('events/'+f);
  }catch(e){}
  const shards=all;
  fs.writeFileSync(path.join(DATA,'meta.json'),JSON.stringify({
    schema:2,source:CFG.source||'aggregator',
    priceUnit:(CFG.source==='rpc')?'SOL':'USD',
    pool:CFG.pool||null,mint:CFG.mint||null,network:CFG.network,stepMs:CFG.stepMs,
    genesisTs:state.genesisTs,pxAth:state.pxAth,athSeeded:state.athSeeded,
    lastStep:state.lastStep,rows:state.rows,
    writer:WRITER||null,minUsd:CFG.minUsd||0,
    shards,gaps:state.gaps||0,deaths:state.deaths||0,
    deathsFile:WRITER?('deaths-'+WRITER+'.csv'):'deaths.csv',
    simStep:state.simStep||0,simHash:state.simHash||'',
    ckStep:state.ckStep||0,ckFile:'checkpoints.jsonl',
    silk:state.silk||0,gen:state.gen||1,
    updated:Date.now()
  },null,2)+'\n');
}
/* The log must not be mixed.
   Changing priceUnit (USD <-> SOL) on a live log gives a 99% drawdown
   and kills the fly - verified by a test. Changing stepMs shifts all steps.
   A different minUsd in two collectors gives different filtering in one
   log. So at startup we check the config against meta and refuse
   to append on a mismatch. */
function checkCompat(){
  const mf=path.join(DATA,'meta.json');
  if(!fs.existsSync(mf))return;
  let m;try{m=JSON.parse(fs.readFileSync(mf,'utf8'));}catch(e){return;}
  const mine={priceUnit:(CFG.source==='rpc')?'SOL':'USD',
    stepMs:CFG.stepMs,pool:CFG.pool,minUsd:CFG.minUsd||0};
  const bad=[];
  if(m.priceUnit&&m.priceUnit!==mine.priceUnit)
    bad.push(`priceUnit: log ${m.priceUnit}, config ${mine.priceUnit}`
      +` (source=${CFG.source||'aggregator'})`);
  if(m.stepMs&&m.stepMs!==mine.stepMs)
    bad.push(`stepMs: log ${m.stepMs}, config ${mine.stepMs}`);
  if(m.pool&&mine.pool&&m.pool!==mine.pool)
    bad.push(`pool: log ${String(m.pool).slice(0,12)}..., config ${String(mine.pool).slice(0,12)}...`);
  if(bad.length){
    console.error('LOG MISMATCH - cannot append:');
    for(const b of bad)console.error('  '+b);
    console.error('Either restore the config or start a new log (a different dataDir).');
    process.exit(2);
  }
  if(m.minUsd!==undefined&&m.minUsd!==mine.minUsd)
    console.warn(`[warn] minUsd: log ${m.minUsd}, config ${mine.minUsd}`
      +' - event filtering will differ between parts of the log');
  if(m.source&&m.source!==(CFG.source||'aggregator'))
    console.warn(`[warn] source: log ${m.source}, config ${CFG.source||'aggregator'}`
      +' - price units match, but event order and completeness may differ');
}
function loadSeen(){
  // recursively, including archive/: otherwise after rotation and
  // a restart archived signatures are not in seen and duplicates are possible
  const walk=(dir)=>{
    if(!fs.existsSync(dir))return;
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const p=path.join(dir,e.name);
      if(e.isDirectory()){walk(p);continue;}
      if(!e.name.endsWith('.csv'))continue;
      for(const line of fs.readFileSync(p,'utf8').split('\n')){
        if(!line||line[0]==='s')continue;
        const c=line.split(',');
        if(c.length<7)continue;
        seen.add(c[6]);
        if(+c[0]>state.lastStep)state.lastStep=+c[0];
        state.rows++;
      }
    }
  };
  walk(EVDIR);
  const mf=path.join(DATA,'meta.json');
  if(fs.existsSync(mf)){
    const m=JSON.parse(fs.readFileSync(mf,'utf8'));
    state.genesisTs=m.genesisTs||0;state.pxAth=m.pxAth||0;
    state.athSeeded=!!m.athSeeded;
  }
}
// Request budget: the public API blocks at about 10 polls/min.
// We keep a hard limit so the IP does not get banned and no hole appears.
const budget={hits:[],max:CFG.maxPollsPerMin||7};
async function get(u){
  const now=Date.now();
  budget.hits=budget.hits.filter(t=>now-t<60000);
  if(budget.hits.length>=budget.max){
    const waitMs=60000-(now-budget.hits[0])+250;
    await new Promise(r=>setTimeout(r,Math.max(0,waitMs)));
    budget.hits=budget.hits.filter(t=>Date.now()-t<60000);
  }
  budget.hits.push(Date.now());
  const r=await fetch(u,{headers:{Accept:'application/json'}});
  if(!r.ok)throw new Error(r.status+' '+String(u).slice(-40));
  return r.json();
}
async function seedAth(){
  const j=await get(`https://api.geckoterminal.com/api/v2/networks/${CFG.network}`
    +`/pools/${CFG.pool}/ohlcv/day?aggregate=1&limit=1000`);
  const lst=(j.data&&j.data.attributes&&j.data.attributes.ohlcv_list)||[];
  let hi=0;for(const c of lst)if(c[2]>hi)hi=c[2];
  return hi;
}
// For a fresh launch: the pool does not appear in the index right away, and genesis
// must be the real first trade. So the collector must be started
// BEFORE the launch - it waits for the pool to appear and catches trade number one.
// If you start later, the provider only serves the last ~300 trades
// and genesis will be fake.
async function fetchTrades(){
  // The provider serves 300 trades per request, no pagination - verified.
  // Collector ceiling = 300 / poll interval. But slots should not be wasted
  // on dust: the game drops trades smaller than DUST_SOL, so we ask
  // the provider to filter them on its side. The window widens
  // exactly by the dust share: at a $10 threshold from 7.7 to 11.7 min.
  const q=CFG.minUsd>0?('?trade_volume_in_usd_greater_than='+CFG.minUsd):'';
  const j=await get(`https://api.geckoterminal.com/api/v2/networks/${CFG.network}`
    +`/pools/${CFG.pool}/trades`+q);
  const out=[];
  for(const x of (j.data||[])){
    const a=x.attributes,buy=a.kind==='buy';
    const sol=parseFloat(buy?a.from_token_amount:a.to_token_amount);
    const px=parseFloat((buy?a.price_to_in_usd:a.price_from_in_usd)||0);
    if(!(sol>0))continue;
    out.push({ts:Date.parse(a.block_timestamp),side:buy?1:-1,
      // NO rounding: toFixed(12) turned a price of 1e-15 into zero,
      // and sol 3e-12 into zero. For a token with a huge supply the log
      // would contain a zero price, and the fly would become immortal.
      // String(double) in JS returns the value exactly.
      sol,px,
      blk:a.block_number|0,sig:a.tx_hash});
  }
  return out;
}
async function tick(){
  try{
    const raw=await fetchTrades();
    state.polls++;
    if(!raw.length)return;
    if(!state.genesisTs){
      state.genesisTs=Math.min.apply(null,raw.map(e=>e.ts));
      console.log(`[init] genesis=${new Date(state.genesisTs).toISOString()}`);
    }
    // ATH from daily candles. If the call failed - keep trying:
    // an understated ATH would give zero drawdown on an already fallen token.
    if(!state.athSeeded){
      try{
        const hi=await seedAth();
        if(hi>0){state.pxAth=Math.max(state.pxAth,hi);state.athSeeded=true;
          console.log(`[init] pxAth=${state.pxAth} (from daily candles)`);}
      }catch(e){console.error('[ath] not yet:',e.message);}
    }
    // Overlap with the previous poll is proof that nothing was missed.
    // Without this check 60 quiet seconds looked like data loss,
    // and the gaps signal is a monitoring alert, it must be reliable.
    const overlap=raw.length-raw.filter(e=>!seen.has(e.sig)).length;
    const fresh=raw.filter(e=>!seen.has(e.sig));
    if(!fresh.length)return;
    for(const e of fresh){
      seen.add(e.sig);
      e.step=Math.floor((e.ts-state.genesisTs)/CFG.stepMs);
      if(e.px>state.pxAth)state.pxAth=e.px;
    }
    // A gap in the log cannot be repaired: the provider only serves the last ~300
    // trades, so what was missed cannot be recovered. So we record it explicitly - and that is
    // why the collector must run without downtime.
    // A gap is real only if there is no overlap: the provider served
    // 300 trades, and we have not seen any of them yet - so between our
    // tail and its window a chunk fell out.
    if(state.lastStep>=0&&overlap===0&&state.polls>1){
      const gapS=((fresh[0].step-state.lastStep)*CFG.stepMs/1000).toFixed(0);
      console.warn(`[gap] no overlap with the previous poll,`
        +` ${gapS}s of log lost (served ${raw.length} trades)`);
      state.gaps=(state.gaps||0)+1;
    }
    fresh.sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));
    appendRows(fresh);
    advanceSim(fresh);
    state.rows+=fresh.length;
    state.lastStep=Math.max(state.lastStep,fresh[fresh.length-1].step);
    writeMeta();
    console.log(`[${new Date().toISOString().slice(11,19)}] +${fresh.length}`
      +`  total=${state.rows}  step=${state.lastStep}`);
  }catch(e){
    state.errs++;
    if(!state.genesisTs&&/40[34]/.test(e.message))
      console.log('[wait] pool not indexed yet, waiting for launch');
    else console.error('[err]',e.message);
  }
}
/* Event source.
     'aggregator' - polling a public API. Ceiling ~3400 significant
                    trades/min: a window of 300 trades per request, no
                    pagination (verified limit/page/cursor).
     'rpc'        - Solana RPC directly. logsSubscribe gives slots with
                    pool activity, getBlock returns all trades in the
                    slot. The request count is bounded by network
                    speed (~150 slots/min) and does NOT depend on the trade
                    rate, so 10,000+ trades/min are reachable.
                    Price is in SOL per token, not USD.
   The public RPC throttles getBlock - this mode needs
   a paid endpoint. */
let rpcSrc=null;
function startRpc(){
  if(!CFG.pool&&!CFG.mint){
    console.error('Neither pool nor mint is set.');
    console.error('For a launch set mint (the token address) - the pool will be found');
    console.error('from the very first trade. For an existing token you can set pool.');
    process.exit(2);
  }
  rpcSrc=new RpcSource(CFG,(evs)=>{
    ingestEvents(evs.map(e=>({ts:e.ts,side:e.side,sol:e.sol,
      px:e.px,blk:e.blk,sig:e.sig})));
  },(m)=>console.log(m));
  /* A pool found via the mint must be locked: the DNA seed is
     derived from it, and it goes into meta for the client. */
  rpcSrc.onPool=(p)=>{
    CFG.pool=p;
    if(E.seedFromString)E.SIMC.GENESIS_SEED=E.seedFromString(String(p));
    console.log('[init] pool locked: '+p);
    writeMeta();
  };
  rpcSrc.connect();
  console.log(`[rpc] mode ${CFG.rpcMode||'block'}, endpoint ${rpcSrc.http}`
    +(CFG.pool?'':', listening to mint '+String(CFG.mint).slice(0,10)+'...'));
  // heartbeat: without it you cannot see whether the source is alive and where it stalls
  setInterval(()=>{
    const s=rpcSrc.stats;
    console.log(`[rpc] messages ${s.notif} slots ${rpcSrc.slots.size}`
      +`/${rpcSrc.slotDone.size} blocks ${s.blocks||0} inspected ${s.fetched}`
      +` trades ${s.trades} throttled ${s.throttled||0} errors ${s.errs}`);
  },CFG.rpcStatsMs||20000);
}
function ingestEvents(raw){
  try{
    state.polls++;
    if(!raw||!raw.length)return;
    if(!state.genesisTs){
      state.genesisTs=Math.min.apply(null,raw.map(e=>e.ts));
      console.log(`[init] genesis=${new Date(state.genesisTs).toISOString()}`);
    }
    const overlap=raw.length-raw.filter(e=>!seen.has(e.sig)).length;
    const fresh=raw.filter(e=>!seen.has(e.sig));
    if(!fresh.length)return;
    for(const e of fresh){
      seen.add(e.sig);
      e.step=Math.floor((e.ts-state.genesisTs)/CFG.stepMs);
      if(e.px>state.pxAth){state.pxAth=e.px;state.athSeeded=true;}
    }
    fresh.sort((a,b)=>(a.step-b.step)||(a.blk-b.blk)||(a.sig<b.sig?-1:1));
    appendRows(fresh);
    advanceSim(fresh);
    state.rows+=fresh.length;
    state.lastStep=Math.max(state.lastStep,fresh[fresh.length-1].step);
    writeMeta();
    console.log(`[${new Date().toISOString().slice(11,19)}] +${fresh.length}`
      +`  total=${state.rows}  step=${state.lastStep}`);
  }catch(e){state.errs++;console.error('[err]',e.message);}
}
checkCompat();
loadSeen();
console.log(`collector${WRITER?' ['+WRITER+']':''}: `
  +(CFG.pool?('pool '+CFG.pool):('mint '+(CFG.mint||'not set')))
  +` / ${CFG.network}`);
console.log(`from disk: ${state.rows} events, step ${state.lastStep}`);
let iv=null;
if((CFG.source||'aggregator')==='rpc'){
  startRpc();
}else{
  console.log(`source: aggregator, poll ${CFG.pollMs}ms`);
  tick();
  iv=setInterval(tick,CFG.pollMs);
}
process.on('SIGINT',()=>{if(iv)clearInterval(iv);if(rpcSrc)rpcSrc.close();
  writeMeta();console.log('\nstopped');process.exit(0);});
