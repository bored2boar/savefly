#!/usr/bin/env node
/* Event source straight from Solana RPC.
   Needed because aggregators serve a fixed window (300 trades per
   request), and above ~3400 trades/min data is lost for good.

   Scheme:
     1. logsSubscribe on the pool - real-time push, no polling
        and no window. Filtering by AMM program drops ~70% of the noise
        (bots probing the pool).
     2. getTransaction in batches of 200 - measured 65,000 tx/min
        on the free public RPC.
     3. Amounts come from the deltas of the pool's OWN accounts. This works for
        any AMM and does not depend on decoding instructions:
          pool gave SOL, received token -> sell
          pool received SOL, gave token -> buy
        Even in swaps routed through several pools the deltas
        of the pool itself stay clean.
     4. Price is in SOL per token, not USD. Silk is a ratio to ATH,
        so units do not matter, and the dependence on the
        SOL/USD rate disappears.
   ──────────────────────────────────────────────────────────── */
const WSOL='So11111111111111111111111111111111111111112';

class RpcSource{
  constructor(cfg,onEvents,log){
    this.cfg=cfg;
    this.onEvents=onEvents;
    this.log=log||(()=>{});
    this.http=cfg.rpcHttp||'https://api.mainnet-beta.solana.com';
    this.wsUrl=cfg.rpcWs||this.http.replace(/^http/,'ws');
    /* What we listen to.
       The POOL address is hard to know before it exists: for pump.fun it is
       a PDA from the mint, and deriving it during launch is an unnecessary
       risk. You know the MINT address for sure: you create it yourself.
       So we can listen to the mint and find the pool from the very first trade:
       the pool is the owner whose SOL and token move in
       opposite directions.
       logsSubscribe on a valid address with no account works -
       verified - so you can subscribe BEFORE the token is created. */
    this.pool=cfg.pool||null;
    this.mint=cfg.mint||null;
    this.watch=this.pool||this.mint;
    if(!this.watch)throw new Error('pool or mint required in the config');
    /* The program filter is self-learning. Auto-detecting a single
       program does not work: swaps are often routed through several
       AMMs, and a guessed "main" one cut off all trades.
       So: first we pull everything, and every RECOGNIZED trade adds its
       programs to the set. After LEARN_N messages the set is considered
       ready and we start filtering. */
    this.ammSet=new Set(cfg.ammPrograms||[]);
    this.learn=cfg.rpcLearn===undefined?400:cfg.rpcLearn;
    this.boiler=/^(Token|Compute|11111111|AToken|Sysvar|Memo)/;
    this.batch=cfg.rpcBatch||200;
    this.pending=[];
    this.seen=new Set();
    this.stats={notif:0,filtered:0,fetched:0,trades:0,batches:0,errs:0,reconnects:0};
    this.ws=null;this.subId=null;this.closed=false;
    this.flushTimer=null;
    /* Two modes for fetching amounts:
         'tx'    - getTransaction per signature. Simple, but
                   the request count grows with the trade rate, and a batch
                   of 200 is counted by the provider as 200 requests.
         'block' - getBlock on slots with pool activity.
                   One request per slot returns ALL trades in it, so
                   the request count is bounded by the network speed
                   (~150 slots/min) and does not depend on the trade rate.
                   Measured: 93 swaps in one block, 246 ms, 3.25 MB.
       Slot numbers come from logsNotification.context.slot, so
       a quiet token costs a few requests per minute, not 150. */
    this.mode=cfg.rpcMode||'block';
    /* Commitment level.
       On confirmed a block can roll back, and then the log keeps
       a trade that is not on chain. The log is append-only, it cannot
       be fixed. Measured over 2500 slots: 0 vanished, so the risk is
       small - but one rollback corrupts the log forever, and the whole
       architecture relies on it being correct.
       So the default is finalized: the cost is about 13 s of delay
       (measured: confirmed/finalized gap of 32 slots), and it fits
       within the LAG_MS budget. */
    this.commitment=cfg.rpcCommitment||'finalized';
    this.slots=new Set();
    this.slotDone=new Set();
    this.slotTimer=null;
  }
  // 429 from a public RPC is normal under load, so we wait
  // and retry instead of losing the event.
  async post(body,tag){
    for(let a=0;a<5;a++){
      const r=await fetch(this.http,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(r.status===429||r.status===503){
        this.stats.throttled=(this.stats.throttled||0)+1;
        await new Promise(x=>setTimeout(x,400*Math.pow(2,a)));
        continue;
      }
      if(!r.ok)throw new Error(tag+' '+r.status);
      return r.json();
    }
    throw new Error(tag+' 429 after 5 attempts');
  }
  async rpc(method,params){
    const j=await this.post({jsonrpc:'2.0',id:1,method,params},method);
    if(j.error)throw new Error(method+': '+(j.error.message||'').slice(0,80));
    return j.result;
  }
  async rpcBatch(items){return this.post(items,'batch');}


  /* The SOL side of a swap sits in different places depending on the AMM:
       - Raydium and similar keep WSOL in the pool's token account;
       - pump.fun AMM keeps SOL as native lamports in the pool
         account itself.
     So we take the sum of both. Without the native part pump pools gave
     zero trades: they simply have no WSOL account.
     Measured on a live trade: the native delta +3.950617 SOL exactly
     equals the amount the aggregator shows. */
  nativePoolDelta(tx){
    const m=tx.meta;
    if(!m||!m.preBalances||!m.postBalances)return 0;
    const tr=tx.transaction||{};
    // getBlock puts keys in transaction.accountKeys,
    // getTransaction - in transaction.message.accountKeys
    let keys=tr.accountKeys||(tr.message&&tr.message.accountKeys)||[];
    const pk=(k)=>(typeof k==='string')?k:(k&&k.pubkey);
    let d=0;
    const n=Math.min(m.preBalances.length,m.postBalances.length,keys.length);
    for(let i=0;i<n;i++){
      if(pk(keys[i])!==this.pool)continue;
      d+=(m.postBalances[i]-m.preBalances[i])/1e9;
    }
    // addresses from lookup tables, if they are separate
    const alt=m.loadedAddresses;
    if(alt&&keys.length<m.preBalances.length){
      const extra=[].concat(alt.writable||[],alt.readonly||[]);
      for(let j=0;j<extra.length;j++){
        const i=keys.length+j;
        if(i>=m.preBalances.length)break;
        if(extra[j]!==this.pool)continue;
        d+=(m.postBalances[i]-m.preBalances[i])/1e9;
      }
    }
    return d;
  }

  /* Finding the pool by mint. The pool is the only owner whose SOL and
     our token move in opposite directions in this transaction.
     A trader does not look like that: they also have both deltas, but
     the SOL delta includes fees and gas, and most importantly the pool holds
     a token account, while a trader may go through a route. */
  findPool(t){
    const m=t&&t.meta;
    if(!m||m.err)return null;
    const tr=t.transaction||{};
    const keys=tr.accountKeys||(tr.message&&tr.message.accountKeys)||[];
    const pk=(k)=>(typeof k==='string')?k:(k&&k.pubkey);
    const tok={},wsol={};
    const add=(o,owner,d)=>{o[owner]=(o[owner]||0)+d;};
    const grab=(lst,sign)=>{
      for(const b of lst||[]){
        const v=+(b.uiTokenAmount&&b.uiTokenAmount.uiAmount||0)*sign;
        if(!b.owner)continue;
        if(b.mint===this.mint)add(tok,b.owner,v);
        else if(b.mint===WSOL)add(wsol,b.owner,v);
      }
    };
    grab(m.preTokenBalances,-1);grab(m.postTokenBalances,1);
    // native lamports per owner account
    const lam={};
    const n=Math.min(m.preBalances.length,m.postBalances.length,keys.length);
    for(let i=0;i<n;i++)
      lam[pk(keys[i])]=(m.postBalances[i]-m.preBalances[i])/1e9;
    for(const owner in tok){
      const dt=tok[owner];
      if(!(Math.abs(dt)>0))continue;
      const ds=(wsol[owner]||0)+(lam[owner]||0);
      if(!(Math.abs(ds)>1e-9))continue;
      if((ds<0)!==(dt<0))return owner;   // opposite directions - that is the pool
    }
    return null;
  }

  // ── parsing one transaction into an event ──
  parse(tx,sig){
    if(!tx||!tx.meta||tx.meta.err)return null;
    const m=tx.meta;
    let dSol=0,dTok=0,mint=null;
    const acc=(b)=>b.owner===this.pool;
    const pre=new Map(),post=new Map();
    for(const b of m.preTokenBalances||[])
      if(acc(b))pre.set(b.accountIndex,b);
    for(const b of m.postTokenBalances||[])
      if(acc(b))post.set(b.accountIndex,b);
    const idx=new Set([...pre.keys(),...post.keys()]);
    for(const i of idx){
      const a=pre.get(i),b=post.get(i);
      const mt=(b||a).mint;
      const va=a?+(a.uiTokenAmount.uiAmount||0):0;
      const vb=b?+(b.uiTokenAmount.uiAmount||0):0;
      const d=vb-va;
      if(mt===WSOL)dSol+=d;
      else if(Math.abs(d)>Math.abs(dTok)){dTok=d;mint=mt;}
    }
    dSol+=this.nativePoolDelta(tx);
    if(!(Math.abs(dSol)>1e-9)||!(Math.abs(dTok)>0))return null;
    if((dSol<0)===(dTok<0))return null;      // not a swap
    // pool gave SOL (dSol<0) - the trader sold the token
    const side=dSol<0?-1:1;
    const sol=Math.abs(dSol);
    const px=sol/Math.abs(dTok);
    if(!(px>0)||!isFinite(px))return null;
    return {ts:(tx.blockTime||0)*1000,side,sol,px,blk:tx.slot|0,sig,mint};
  }

  async fetchBatch(sigs){
    const items=sigs.map((s,i)=>({jsonrpc:'2.0',id:i,method:'getTransaction',
      params:[s,{maxSupportedTransactionVersion:0,encoding:'jsonParsed',
        commitment:this.commitment}]}));
    let out;
    try{out=await this.rpcBatch(items);}
    catch(e){this.stats.errs++;this.log('[rpc] batch: '+e.message);return [];}
    this.stats.batches++;
    const evs=[];
    for(const r of out){
      this.stats.fetched++;
      const i=(r&&r.id!==undefined)?r.id:0;
      const tx=r&&r.result;
      const ev=this.parse(tx,sigs[i]);
      if(ev){evs.push(ev);this.stats.trades++;this.learnFrom(tx);}
    }
    return evs;
  }
  learnFrom(tx){
    for(const l of (tx.meta.logMessages||[])){
      if(l.startsWith('Program ')&&l.indexOf(' invoke [')>0){
        const p=l.split(' ')[1];
        if(this.boiler.test(p))continue;
        this.ammSet.add(p);
      }
    }
  }
  queue(sig){
    if(this.seen.has(sig))return;
    this.seen.add(sig);
    if(this.seen.size>200000){
      let n=0;for(const k of this.seen){this.seen.delete(k);if(++n>50000)break;}
    }
    this.pending.push(sig);
    if(this.pending.length>=this.batch)this.flush();
    else if(!this.flushTimer)
      this.flushTimer=setTimeout(()=>this.flush(),this.cfg.rpcFlushMs||1500);
  }
  // ── block mode ──
  queueSlot(slot){
    if(this.slotDone.has(slot))return;
    this.slots.add(slot);
    if(this.slotDone.size>20000){
      let n=0;for(const k of this.slotDone){this.slotDone.delete(k);if(++n>5000)break;}
    }
    if(!this.slotTimer)
      this.slotTimer=setTimeout(()=>this.drainSlots(),this.cfg.rpcSlotDelayMs||1200);
  }
  parseBlockTx(t,slot,blockTime){
    const m=t&&t.meta;
    if(!m||m.err)return null;
    if(!this.pool&&this.mint){
      const p=this.findPool(t);
      if(!p)return null;
      this.pool=p;
      this.log('[rpc] pool found via mint: '+p);
      if(this.onPool)this.onPool(p);
    }
    let dSol=0,dTok=0,mint=null;
    const pre=new Map(),post=new Map();
    for(const b of m.preTokenBalances||[])if(b.owner===this.pool)pre.set(b.accountIndex,b);
    for(const b of m.postTokenBalances||[])if(b.owner===this.pool)post.set(b.accountIndex,b);
    const idx=new Set([...pre.keys(),...post.keys()]);
    if(!idx.size)return null;
    for(const i of idx){
      const a=pre.get(i),b=post.get(i);
      const mt=(b||a).mint;
      const va=a?+(a.uiTokenAmount.uiAmount||0):0;
      const vb=b?+(b.uiTokenAmount.uiAmount||0):0;
      const d=vb-va;
      if(mt===WSOL)dSol+=d;
      else if(Math.abs(d)>Math.abs(dTok)){dTok=d;mint=mt;}
    }
    dSol+=this.nativePoolDelta(t);
    if(!(Math.abs(dSol)>1e-9)||!(Math.abs(dTok)>0))return null;
    if((dSol<0)===(dTok<0))return null;      // not a swap
    const sig=(t.transaction&&t.transaction.signatures&&t.transaction.signatures[0])||'';
    if(!sig)return null;
    const px=Math.abs(dSol)/Math.abs(dTok);
    if(!(px>0)||!isFinite(px))return null;
    return{ts:(blockTime||0)*1000,side:dSol<0?-1:1,
      sol:Math.abs(dSol),px,blk:slot|0,sig,mint};
  }
  async fetchSlot(slot){
    let b;
    try{
      b=await this.rpc('getBlock',[slot,{encoding:'jsonParsed',
        transactionDetails:'accounts',rewards:false,
        commitment:this.commitment,
        maxSupportedTransactionVersion:1}]);
    }catch(e){
      // the slot may have been skipped - not an error
      if(/skipped|not available|Slot/i.test(e.message))return [];
      this.stats.errs++;this.log('[rpc] getBlock '+slot+': '+e.message);return [];
    }
    if(!b||!b.transactions)return [];
    this.stats.blocks=(this.stats.blocks||0)+1;
    this.stats.fetched+=b.transactions.length;
    const out=[];
    for(const t of b.transactions){
      const ev=this.parseBlockTx(t,slot,b.blockTime);
      if(ev&&!this.seen.has(ev.sig)){this.seen.add(ev.sig);out.push(ev);this.stats.trades++;}
    }
    return out;
  }
  async drainSlots(){
    if(this.slotTimer){clearTimeout(this.slotTimer);this.slotTimer=null;}
    const list=[...this.slots].sort((a,b)=>a-b);
    this.slots.clear();
    const par=this.cfg.rpcSlotParallel||3;
    const all=[];
    for(let i=0;i<list.length;i+=par){
      const chunk=list.slice(i,i+par);
      const res=await Promise.all(chunk.map(s=>this.fetchSlot(s)));
      for(const c of chunk)this.slotDone.add(c);
      for(const r of res)for(const e of r)all.push(e);
    }
    if(all.length){
      all.sort((a,b)=>(a.blk-b.blk)||(a.sig<b.sig?-1:1));
      this.onEvents(all);
    }
    if(this.slots.size)this.drainSlots();
  }
  async flush(){
    if(this.flushTimer){clearTimeout(this.flushTimer);this.flushTimer=null;}
    if(!this.pending.length)return;
    const take=this.pending.splice(0,this.batch);
    const evs=await this.fetchBatch(take);
    if(evs.length)this.onEvents(evs);
    if(this.pending.length)this.flush();
  }

  // ── opening the subscription ──
  connect(){
    if(this.closed)return;
    let ws;
    try{ws=new WebSocket(this.wsUrl);}
    catch(e){this.log('[rpc] ws: '+e.message);return this.retry();}
    this.ws=ws;
    ws.onopen=()=>{
      this.log('[rpc] subscribed to '+this.watch.slice(0,8)+'...'+
        (this.pool?'':' (mint; pool will be found from the first trade)'));
      ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',
        params:[{mentions:[this.watch]},
          {commitment:this.commitment==='finalized'?'finalized':'confirmed'}]}));
    };
    ws.onmessage=(e)=>{
      let m;try{m=JSON.parse(e.data);}catch(_){return;}
      if(m.id===1){
        if(m.error)this.log('[rpc] logsSubscribe: '+(m.error.message||''));
        else this.subId=m.result;
        return;
      }
      if(m.method!=='logsNotification')return;
      const ctx=m.params.result.context||{};
      const v=m.params.result.value;
      this.stats.notif++;
      if(v.err)return;
      if(this.mode==='block'){
        // in block mode the signature is not needed: knowing the slot is enough
        if(Number.isFinite(ctx.slot))this.queueSlot(ctx.slot);
        this.stats.filtered++;
        return;
      }
      // While learning - take everything. Then filter by the set of programs
      // that already produced real trades: this drops bots probing
      // the pool, and does not require guessing the "main" AMM.
      if(this.learn>0)this.learn--;
      else if(this.ammSet.size&&!v.logs.some(l=>{
        const i=l.indexOf('Program ');
        if(i!==0)return false;
        return this.ammSet.has(l.split(' ')[1]);
      }))return;
      this.stats.filtered++;
      this.queue(v.signature);
    };
    ws.onclose=()=>{if(!this.closed){this.stats.reconnects++;this.retry();}};
    ws.onerror=()=>{};
  }
  retry(){
    if(this.closed)return;
    const d=Math.min(30000,1000*Math.pow(1.7,Math.min(8,this.stats.reconnects)));
    setTimeout(()=>this.connect(),d);
  }

  // ── fetching history: cold start and closing gaps ──
  async backfill(limit,before){
    const out=[];
    let cursor=before||null,got=0;
    while(got<limit){
      const p=[this.watch,{limit:Math.min(1000,limit-got),commitment:this.commitment}];
      if(cursor)p[1].before=cursor;
      let sigs;
      try{sigs=await this.rpc('getSignaturesForAddress',p);}
      catch(e){this.log('[rpc] backfill: '+e.message);break;}
      if(!sigs||!sigs.length)break;
      const good=sigs.filter(s=>!s.err).map(s=>s.signature);
      for(let i=0;i<good.length;i+=this.batch){
        const evs=await this.fetchBatch(good.slice(i,i+this.batch));
        for(const e of evs){if(!this.seen.has(e.sig)){this.seen.add(e.sig);out.push(e);}}
      }
      got+=sigs.length;
      cursor=sigs[sigs.length-1].signature;
      if(sigs.length<1000)break;
    }
    out.sort((a,b)=>(a.blk-b.blk)||(a.sig<b.sig?-1:1));
    return out;
  }
  close(){this.closed=true;try{this.ws&&this.ws.close();}catch(e){}}
}
module.exports={RpcSource,WSOL};
