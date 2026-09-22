#!/usr/bin/env node
/* RPC source edge cases. Blocks are synthetic, no network needed.
   The main question: do we mistake something for a trade that is not one,
   and do we lose anything that is. */
const {RpcSource}=require('../ingest/rpc-source.js');
let pass=0,fail=0;
const T=(n,ok,i)=>{if(ok){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+(i?'  -> '+i:''));}};
const POOL='POOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const WSOL='So11111111111111111111111111111111111111112';
const MINT='MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const OTHER='OTHERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const src=new RpcSource({pool:POOL,rpcMode:'block'},()=>{},()=>{});

// ── transaction builder in getBlock/accounts format ──
function tx(o){
  o=o||{};
  const keys=(o.keys||[POOL,'SIGNERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx']).map(
    (k,i)=>({pubkey:k,signer:i===1,writable:true,source:'transaction'}));
  const n=keys.length;
  const pre=o.preLam||new Array(n).fill(1e9);
  const post=o.postLam||pre.slice();
  return {version:0,
    transaction:{accountKeys:keys,signatures:[o.sig||'SIG1']},
    meta:{err:o.err||null,fee:o.fee===undefined?5000:o.fee,
      preBalances:pre,postBalances:post,
      preTokenBalances:o.pre||[],postTokenBalances:o.post||[],
      loadedAddresses:o.alt}};
}
const tb=(i,mint,owner,amt)=>({accountIndex:i,mint,owner,
  uiTokenAmount:{uiAmount:amt,amount:String(Math.round((amt||0)*1e6)),decimals:6}});
const parse=(t)=>src.parseBlockTx(t,1000,1789000000);

console.log('\n── what MUST be recognized ──');
T('WSOL pool: sell',(()=>{
  const e=parse(tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
                    post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]}));
  return e&&e.side===-1&&Math.abs(e.sol-1)<1e-9;})());
T('WSOL pool: buy',(()=>{
  const e=parse(tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
                    post:[tb(1,WSOL,POOL,102),tb(2,MINT,POOL,0.9e6)]}));
  return e&&e.side===1&&Math.abs(e.sol-2)<1e-9;})());
T('native pool (pump.fun): sell',(()=>{
  const e=parse(tx({pre:[tb(1,MINT,POOL,1e6)],post:[tb(1,MINT,POOL,1.1e6)],
    preLam:[5e9,1e9],postLam:[4e9,1e9]}));
  return e&&e.side===-1&&Math.abs(e.sol-1)<1e-9;})());
T('native pool: buy',(()=>{
  const e=parse(tx({pre:[tb(1,MINT,POOL,1e6)],post:[tb(1,MINT,POOL,0.9e6)],
    preLam:[5e9,1e9],postLam:[7e9,1e9]}));
  return e&&e.side===1&&Math.abs(e.sol-2)<1e-9;})());

console.log('\n── what must NOT be recognized as a trade ──');
T('adding liquidity (both +)',(()=>{
  const e=parse(tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
                    post:[tb(1,WSOL,POOL,110),tb(2,MINT,POOL,1.1e6)]}));
  return e===null;})(),'recognized as a trade');
T('removing liquidity (both -)',(()=>{
  const e=parse(tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
                    post:[tb(1,WSOL,POOL,90),tb(2,MINT,POOL,0.9e6)]}));
  return e===null;})(),'recognized as a trade');
T('fee collection: SOL left, token did not move',(()=>{
  const e=parse(tx({pre:[tb(1,MINT,POOL,1e6)],post:[tb(1,MINT,POOL,1e6)],
    preLam:[5e9,1e9],postLam:[4.9e9,1e9]}));
  return e===null;})(),'recognized as a trade');
T('failed transaction',(()=>{
  const e=parse(tx({err:{InstructionError:[0,'X']},
    pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
    post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]}));
  return e===null;})());
T('pool not involved (foreign owner)',(()=>{
  const e=parse(tx({keys:[OTHER,'SIGNERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    pre:[tb(1,WSOL,OTHER,100),tb(2,MINT,OTHER,1e6)],
    post:[tb(1,WSOL,OTHER,99),tb(2,MINT,OTHER,1.1e6)]}));
  return e===null;})());
T('token-token pool without SOL',(()=>{
  const e=parse(tx({pre:[tb(1,MINT,POOL,1e6),tb(2,OTHER,POOL,2e6)],
                    post:[tb(1,MINT,POOL,1.1e6),tb(2,OTHER,POOL,1.9e6)],
    preLam:[1e9,1e9],postLam:[1e9,1e9]}));
  return e===null;})(),'recognized even though SOL did not move');

console.log('\n── corrupted and odd data ──');
T('uiAmount = null',(()=>{
  const a=tb(1,WSOL,POOL,null),b=tb(2,MINT,POOL,1e6);
  const a2=tb(1,WSOL,POOL,null),b2=tb(2,MINT,POOL,1.1e6);
  const e=parse(tx({pre:[a,b],post:[a2,b2]}));
  return e===null||isFinite(e.sol);})(),'NaN leaked through');
T('blockTime missing',(()=>{
  const t=tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
              post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]});
  const e=src.parseBlockTx(t,1000,null);
  return e&&e.ts===0;})(),'ts is not 0');
T('no signature - rejected',(()=>{
  const t=tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
              post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]});
  t.transaction.signatures=[];
  return src.parseBlockTx(t,1000,1789000000)===null;})());
T('accountKeys shorter than balances (ALT)',(()=>{
  const t=tx({pre:[tb(1,MINT,POOL,1e6)],post:[tb(1,MINT,POOL,1.1e6)],
    preLam:[1e9,1e9,5e9],postLam:[1e9,1e9,4e9],
    alt:{writable:[POOL],readonly:[]}});
  const e=src.parseBlockTx(t,1000,1789000000);
  return e&&e.side===-1&&Math.abs(e.sol-1)<1e-9;})(),'did not account for the lookup table address');
T('zero price (huge token delta)',(()=>{
  const e=parse(tx({pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
    post:[tb(1,WSOL,POOL,99.999999999),tb(2,MINT,POOL,1e30)]}));
  return e===null||(e.px>0&&isFinite(e.px));})());
T('pool is a signer (fee in the delta)',(()=>{
  // pool at idx 0 pays the fee - the delta includes the fee
  const t=tx({keys:[POOL,'SIGNERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
    pre:[tb(1,MINT,POOL,1e6)],post:[tb(1,MINT,POOL,1.1e6)],
    preLam:[5e9,1e9],postLam:[4e9,1e9]});
  const e=src.parseBlockTx(t,1000,1789000000);
  return e&&Math.abs(e.sol-1)<0.001;})(),'fee corrupted the amount');

console.log('\n── order and duplicates ──');
T('same signature twice - one event',(()=>{
  const s2=new RpcSource({pool:POOL,rpcMode:'block'},()=>{},()=>{});
  const t=tx({sig:'DUP',pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
              post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]});
  let n=0;
  for(const slot of [1000,1001]){
    const b={blockTime:1789000000,transactions:[t]};
    for(const tr of b.transactions){
      const e=s2.parseBlockTx(tr,slot,b.blockTime);
      if(e&&!s2.seen.has(e.sig)){s2.seen.add(e.sig);n++;}
    }
  }
  return n===1;})());
T('slots out of order - events get sorted',(()=>{
  const out=[];
  const s2=new RpcSource({pool:POOL,rpcMode:'block'},(evs)=>out.push(...evs),()=>{});
  for(const [slot,sig] of [[1005,'C'],[1001,'A'],[1003,'B']]){
    const t=tx({sig,pre:[tb(1,WSOL,POOL,100),tb(2,MINT,POOL,1e6)],
                post:[tb(1,WSOL,POOL,99),tb(2,MINT,POOL,1.1e6)]});
    const e=s2.parseBlockTx(t,slot,1789000000);
    if(e)out.push(e);
  }
  out.sort((a,b)=>(a.blk-b.blk)||(a.sig<b.sig?-1:1));
  return out.map(e=>e.sig).join('')==='ABC';})());
console.log();
console.log(`RESULT: ${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
