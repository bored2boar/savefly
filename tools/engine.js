/* Single source of the engine: we extract the simulation from the game so the collector,
   the replayer and the tests run the same code, not copies. */
const fs=require('fs'),path=require('path');
function loadEngine(htmlPath){
  const html=fs.readFileSync(htmlPath||
    path.join(__dirname,'..','src','savefly.html'),'utf8');
  const js=html.split('<script>')[1].split('</script>')[0];
  const a=js.indexOf('const SIMC={'), b=js.indexOf('/* ── FEED LAYER');
  // mkDNA sits above the engine - take it as a separate slice, it is needed
  // by the collector so the death registry contains generation names
  // the DNA tables sit before mkDNA - take from the first of them
  let da=js.indexOf('function mkDNA(');
  const tb=js.lastIndexOf('const MORPHS',da);
  if(tb>=0)da=tb;
  const db=js.indexOf('function fullName(');
  const dna=(da>=0&&db>da)?js.slice(da,db):'';
  if(a<0||b<0)throw new Error('engine boundaries not found in savefly.html');
  // the collector needs mkDNA so the death registry has generation names.
  // Instead of listing dependencies by hand we collect them automatically:
  // take the body of mkDNA, find all referenced UPPER CASE
  // tables and cut out their declarations with bracket balancing.
  function stmtAt(i){
    if(i<0)return '';
    let d=0,j=i;
    for(;j<js.length;j++){
      const c=js[j];
      if(c==='['||c==='('||c==='{')d++;
      else if(c===']'||c===')'||c==='}')d--;
      else if(c===';'&&d<=0){j++;break;}
      else if(c==='\n'&&d<=0&&j>i+4)break;
    }
    return js.slice(i,j)+'\n';
  }
  function fnAt(name){
    const i=js.indexOf('function '+name+'(');
    if(i<0)return '';
    const k=js.indexOf('{',i);
    let d=0;
    for(let j=k;j<js.length;j++){
      if(js[j]==='{')d++;
      else if(js[j]==='}'){d--;if(!d)return js.slice(i,j+1)+'\n';}
    }
    return '';
  }
  const dnaFn=fnAt('mkDNA');
  let deps='';
  if(dnaFn){
    const seen={};
    for(const m of dnaFn.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)){
      const n=m[0];
      if(seen[n]||n==='SIMC'||n==='WEB')continue;
      seen[n]=1;
      const at=js.search(new RegExp('^const '+n+'\\s*=','m'));
      if(at>=0)deps+=stmtAt(at);
    }
  }
  // dependency functions too, automatically, in two passes
  let helpers='';
  {
    const have={mkDNA:1,cl:1,hsl:1,lerp:1,spokeStatic:1};
    let pool=dnaFn;
    for(let pass=0;pass<4;pass++){
      let added='';
      for(const m of pool.matchAll(/\b([a-z][A-Za-z0-9_]*)\s*\(/g)){
        const n=m[1];
        if(have[n])continue;
        if(['if','for','while','return','function','switch','catch','typeof','Math','String','Number','Array','Object','JSON'].indexOf(n)>=0)continue;
        const body=fnAt(n);
        if(!body)continue;
        have[n]=1;helpers+=body;added+=body;
      }
      if(!added)break;
      pool=added;
    }
  }
  const STUB=`const RW=320,RH=224;
function cl(v,x,y){return v<x?x:(v>y?y:v);}
function hsl(h,s,l){return 'hsl('+Math.round(h)+','+Math.round(cl(s,0,100))+'%,'+Math.round(cl(l,0,100))+'%)';}
function lerp(a,b,t){return a+(b-a)*t;}
const WEB={cx:160,cy:96,spokes:12,rings:6};const SPOKE=[];
for(let i=0;i<12;i++)SPOKE.push({a:i/12*6.28319,len:100+(i%5)*9,sag:.06+(i%4)*.02,vib:0});
function spokeStatic(i,t){const s=SPOKE[i],r=s.len*t;
  return[WEB.cx+Math.cos(s.a)*r,WEB.cy+Math.sin(s.a)*r+Math.sin(t*Math.PI)*s.len*s.sag*.30];}
`+helpers+deps+dnaFn;
  const E={};
  (new Function('exp',STUB+js.slice(a,b)+`
    exp.SIMC=SIMC;exp.simGenesis=simGenesis;exp.simStep=simStep;
    exp.simApplyEvent=simApplyEvent;exp.simHash=simHash;exp.OUTQ=OUTQ;
    exp.solToSize=solToSize;exp.srnd=srnd;
    exp.seedFromString=(typeof seedFromString==='function')?seedFromString:null;
    exp.mkDNA=(typeof mkDNA==='function')?mkDNA:null;
    exp.set=(v)=>{S=v;};exp.get=()=>S;`))(E);
  return E;
}
// Checkpoint = full state snapshot. Entities too, otherwise the restore
// diverges: spiders and shots in flight are part of the state.
const CK_FIELDS=['step','gen','genStep','seed','px','pxAth','bar','barHi','barClose','athRun',
  'flow','vol','sellAcc','buyAcc',
  'debt','silk','inFlow','outFlow','kills','bites','dead','deadStep',
  'evCount','nextId','ckStep','ckHash','epoch'];
/* Numbers are stored WITHOUT rounding.
   There used to be toFixed(6)/toFixed(9) here for compactness.
   Consequence: a velocity of 6.3e-9 became zero, a coordinate
   287.99999999976 became exactly 288. Within one snapshot the hash usually
   matched (it quantizes), but drift accumulated, and clients that
   restored from different snapshots slowly diverged.
   Found by the fuzzer: 1 failure per 400 random streams.
   JSON in JS round-trips doubles exactly, so full precision costs
   nothing but a few hundred bytes. */
function snapshot(S,hash){
  const o={};
  for(const k of CK_FIELDS)o[k]=S[k];
  o.spiders=S.spiders.map(s=>[s.id,s.spoke,s.t,s.pt,s.size,s.hp,s.sp,s.wob,
    s.step,s.lastTk,s.dying]);
  o.shots=S.shots.map(s=>s.pend!==undefined
    ?['p',s.pend,s.size]
    :['f',s.id,s.x,s.y,s.px,s.py,s.vx,s.vy,s.size,s.life]);
  o.hash=hash;
  return o;
}
function restore(E,o){
  const S=E.simGenesis();
  for(const k of CK_FIELDS)if(o[k]!==undefined)S[k]=o[k];
  S.ckLog=[];
  S.spiders=(o.spiders||[]).map(a=>({id:a[0],spoke:a[1],t:a[2],pt:a[3],
    size:a[4],hp:a[5],sp:a[6],wob:a[7],step:a[8],lastTk:a[9],dying:a[10]}));
  S.shots=(o.shots||[]).map(a=>a[0]==='p'
    ?{pend:a[1],size:a[2]}
    :{id:a[1],x:a[2],y:a[3],px:a[4],py:a[5],vx:a[6],vy:a[7],size:a[8],life:a[9]});
  return S;
}
module.exports={loadEngine,snapshot,restore,CK_FIELDS};
