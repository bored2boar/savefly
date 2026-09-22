#!/usr/bin/env node
/* Writing the game into a Solana account.
   On EVM this required cutting the code into chunks under the 24 KB
   contract limit. On Solana an account holds up to 10 MB - verified
   by reading a 10,240 KB program account - so the game fits
   in ONE account, and no splitter is needed.

   Only the WRITES are chunked: a transaction is limited to 1232 bytes,
   so 36 KB (brotli) is about 42 transactions at 0.000005 SOL.

   The deposit for 36 KB: 0.19 SOL, and it is RETURNED when the account
   is closed. On EVM deployment gas is never returned.

   Account format:
     [0..3]   magic 'SFLY'
     [4]      format version (1)
     [5]      encoding: 0 = raw, 1 = brotli
     [6..9]   content length, uint32 LE
     [10..41] content sha256 (for verification)
     [42..]   the bytes themselves

   This script does NOT sign transactions and holds no keys: it
   prepares the write plan and prints it. Signing is a separate step
   done by a person with their own key.
*/
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const SRC=process.argv[2]||path.join(__dirname,'..','src','savefly.html');
const OUT=process.argv[3]||path.join(__dirname,'payload.bin');
const RPC=process.env.RPC||'https://api.mainnet-beta.solana.com';
const CHUNK=900;          // data bytes per transaction, with headroom

const raw=fs.readFileSync(SRC);
const br=zlib.brotliCompressSync(raw,{params:{
  [zlib.constants.BROTLI_PARAM_QUALITY]:11,
  [zlib.constants.BROTLI_PARAM_SIZE_HINT]:raw.length}});
const useBr=br.length<raw.length;
const body=useBr?br:raw;
const sha=crypto.createHash('sha256').update(body).digest();

const head=Buffer.alloc(42);
head.write('SFLY',0,'ascii');
head[4]=1;
head[5]=useBr?1:0;
head.writeUInt32LE(body.length,6);
sha.copy(head,10);
const payload=Buffer.concat([head,body]);
fs.writeFileSync(OUT,payload);

const txs=Math.ceil(payload.length/CHUNK);
(async()=>{
  let rent=null;
  try{
    const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,
        method:'getMinimumBalanceForRentExemption',params:[payload.length]})});
    const j=await r.json();
    if(j.result)rent=j.result/1e9;
  }catch(e){}
  console.log('source       :',path.relative(process.cwd(),SRC),
    (raw.length/1024).toFixed(1)+' KB');
  console.log('encoding     :',useBr?'brotli':'raw',
    (body.length/1024).toFixed(1)+' KB'+
    (useBr?('  ('+(100-body.length/raw.length*100).toFixed(0)+'% saved)'):''));
  console.log('sha256       :',sha.toString('hex'));
  console.log('payload      :',OUT,(payload.length/1024).toFixed(1)+' KB');
  console.log();
  console.log('write plan:');
  console.log('  account       : one, size',payload.length,'bytes');
  console.log('  deposit       :',rent!==null?(rent.toFixed(4)+' SOL (refundable)'):'?');
  console.log('  transactions  :',txs,'of',CHUNK,'bytes');
  console.log('  total fees    :',(txs*0.000005).toFixed(5),'SOL');
  console.log();
  console.log('next, with a wallet key:');
  console.log('  solana account create --size',payload.length,' # or via SDK');
  console.log('  node onchain/write.js  # prepares payload.bin (done)');
  console.log('  # chunked write: 42 tx, each writes its own offset');
  console.log();
  console.log('verification after writing:');
  console.log('  node onchain/verify.js <account address>');
})();
