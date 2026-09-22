#!/usr/bin/env node
/* Verifies that the account holds exactly this game.
   This is what makes the claim meaningful: not "we put the code on chain",
   but "here is the address, check the hash yourself".

   node onchain/verify.js <address> [file-to-compare]
*/
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto');
const ADDR=process.argv[2];
const CMP=process.argv[3]||path.join(__dirname,'..','src','savefly.html');
const RPC=process.env.RPC||'https://api.mainnet-beta.solana.com';
if(!ADDR){console.error('specify the account address');process.exit(2);}

(async()=>{
  const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',
      params:[ADDR,{encoding:'base64'}]})});
  const j=await r.json();
  if(j.error||!j.result||!j.result.value){
    console.error('account not read:',JSON.stringify(j.error||'empty').slice(0,90));
    process.exit(1);
  }
  const buf=Buffer.from(j.result.value.data[0],'base64');
  console.log('account  :',ADDR);
  console.log('size     :',(buf.length/1024).toFixed(1),'KB');
  console.log('deposit  :',(j.result.value.lamports/1e9).toFixed(4),'SOL');
  if(buf.length<42||buf.toString('ascii',0,4)!=='SFLY'){
    console.error('not a SAVEFLY payload (no SFLY magic)');process.exit(1);}
  const ver=buf[4],enc=buf[5],len=buf.readUInt32LE(6);
  const sha=buf.slice(10,42).toString('hex');
  const body=buf.slice(42,42+len);
  console.log('version  :',ver,' encoding:',enc===1?'brotli':'raw');
  console.log('content  :',(len/1024).toFixed(1),'KB');
  const got=crypto.createHash('sha256').update(body).digest('hex');
  const shaOk=got===sha;
  console.log('sha256   :',got,shaOk?'(matches header)':'DOES NOT MATCH');
  if(!shaOk)process.exit(1);
  // decompress and compare with the local file
  let html;
  try{html=enc===1?zlib.brotliDecompressSync(body):body;}
  catch(e){console.error('failed to decompress:',e.message);process.exit(1);}
  console.log('decompressed:',(html.length/1024).toFixed(1),'KB');
  const isHtml=html.toString('ascii',0,15).toLowerCase().startsWith('<!doctype html');
  console.log('is HTML  :',isHtml?'yes':'NO');
  if(fs.existsSync(CMP)){
    const loc=fs.readFileSync(CMP);
    const same=loc.equals(html);
    console.log();
    console.log('compare with',path.relative(process.cwd(),CMP)+':');
    console.log('  local sha256   :',crypto.createHash('sha256').update(loc).digest('hex'));
    console.log('  on-chain sha256:',crypto.createHash('sha256').update(html).digest('hex'));
    console.log('  ->',same?'IDENTICAL':'DIFFERENT');
    if(!same)process.exit(1);
  }
  console.log();
  console.log('VERIFICATION PASSED');
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
