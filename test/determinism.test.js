#!/usr/bin/env node
/* Demo-mode determinism: the same moment in time at different FPS
   and different join times must give the same state. */
const {execFileSync}=require('child_process'),path=require('path'),fs=require('fs');
const ROOT=path.resolve(__dirname,'..');
const JS='/tmp/_sf.js';
fs.writeFileSync(JS,fs.readFileSync(path.join(ROOT,'src','savefly.html'),'utf8')
  .split('<script>')[1].split('</script>')[0]);
const H=path.join(__dirname,'_simtest.js');
const G=Date.UTC(2026,8,18,0,0,0);
function run(env,clk,args){
  const out=execFileSync(process.execPath,[H,JS,'0',String(clk)],
    {env:Object.assign({},process.env,env),encoding:'utf8',timeout:120000});
  return JSON.parse(out.trim().split('\n').pop());
}
let ok=true;
console.log('1. same moment in time, different FPS');
const CLK=G+40*60000;
let base=null;
for(const fs2 of ['16.7','33.3','8.3','50']){
  const r=run({FSTEP:fs2,RUNMS:'12000'},CLK);
  const key=r.ck+'@'+r.ckStep;
  console.log(`   ${String(Math.round(1000/+fs2)).padStart(3)}fps  ck=${r.ck} @${r.ckStep} silk=${r.silk.toFixed(6)}`);
  if(base===null)base=key;else if(key!==base)ok=false;
}
console.log(base&&ok?'   PASS':'   FAIL');
console.log();
console.log('2. different join time, shared moment');
const TGT=G+2*3600000;
base=null;
for(const off of [15,60,105]){
  const r=run({RUNMS:'2500',JUMPTO:String(TGT)},G+off*60000);
  const key=r.ck+'@'+r.ckStep;
  console.log(`   join +${String(off).padStart(3)}min  ck=${r.ck} @${r.ckStep} gen=${r.gen}`);
  if(base===null)base=key;else if(key!==base)ok=false;
}
console.log(ok?'   PASS':'   FAIL');
console.log();
console.log(ok?'DETERMINISM: PASS':'DETERMINISM: FAIL');
process.exit(ok?0:1);
