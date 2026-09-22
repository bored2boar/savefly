const fs=require('fs');
const full=fs.readFileSync(require('path').join(__dirname,'..','src','savefly.html'),'utf8').split('<script>')[1].split('</script>')[0];
const a=full.indexOf('const SIMC={'), b=full.indexOf('/* ── FEED LAYER');
const engine=full.slice(a,b);
const STUB=`
const RW=320,RH=224;
const WEB={cx:160,cy:96,spokes:12,rings:6};
const SPOKE=[];
for(let i=0;i<WEB.spokes;i++)SPOKE.push({a:i/WEB.spokes*6.28319,len:100+(i%5)*9,sag:.06+(i%4)*.02,vib:0});
function cl(v,x,y){return v<x?x:(v>y?y:v);}
function spokeStatic(i,t){const s=SPOKE[i],r=s.len*t;
  return[WEB.cx+Math.cos(s.a)*r,WEB.cy+Math.sin(s.a)*r+Math.sin(t*Math.PI)*s.len*s.sag*.30];}
`;
const OV={
  SPIDER_CAP:+(process.env.SPCAP||0)||null,
  SHOT_CAP:+(process.env.SHCAP||0)||null,
  BITE_DEBT:+(process.env.DEBT||0)||null,
  SHOT_MULT:+(process.env.SHMULT||0)||null
};
(new Function(STUB+engine+`
  globalThis.SIMC=SIMC;globalThis.simGenesis=simGenesis;globalThis.simStep=simStep;
  globalThis.simApplyEvent=simApplyEvent;globalThis.simHash=simHash;globalThis.OUTQ=OUTQ;
  globalThis.solToSize=solToSize;globalThis.silkStageOf=(s)=>s;
  globalThis.__setS=(v)=>{S=v;};globalThis.__getS=()=>S;
`))();
if(OV.SPIDER_CAP)SIMC.SPIDER_CAP=OV.SPIDER_CAP;
if(OV.SHOT_CAP)SIMC.SHOT_CAP=OV.SHOT_CAP;
if(OV.BITE_DEBT)SIMC.BITE_DEBT=OV.BITE_DEBT;
if(OV.SHOT_MULT)SIMC.SHOT_MULT=OV.SHOT_MULT;
Object.defineProperty(globalThis,'S',{get:()=>globalThis.__getS(),set:(v)=>globalThis.__setS(v)});

function run(events,opt){
  opt=opt||{};
  const evs=events.slice().sort((x,y)=>
    (x.blk-y.blk)||(x.sig<y.sig?-1:x.sig>y.sig?1:0));
  const t0=Math.min(...evs.map(e=>Date.parse(e.ts)));
  SIMC.GENESIS_TS=t0;
  S=simGenesis();
  const px0=evs[0].px||1;
  S.px=px0;S.pxAth=opt.athMult?px0*opt.athMult:px0;
  const stepOf=(ts)=>Math.floor((Date.parse(ts)-t0)/SIMC.STEP_MS);
  const lastStep=Math.max(...evs.map(e=>stepOf(e.ts)))+300;
  let ei=0,dust=0,ent=0,merged=0,maxSp=0,maxSh=0,deaths=0,peakSilk=0,athHits=0;
  let cumKills=0,cumBites=0;
  let shMade=0,shHit=0,shCap=0,shGone=0,spMade=0,sizeSum=0,shSizeSum=0;
  let sumSp=0,n=0;
  for(let st=0;st<=lastStep;st++){
    while(ei<evs.length&&stepOf(evs[ei].ts)<=st){
      const e=evs[ei++];
      if(solToSize(e.sol)===0)dust++;else ent++;
      const q=OUTQ.length,shBefore=S.shots.length;
      simApplyEvent({side:e.side,sol:e.sol,px:e.px});
      const sz=solToSize(e.sol);
      if(sz>0){
        if(e.side>0){const n=Math.max(1,Math.min(8,Math.round(sz*SIMC.SHOT_MULT)));shMade+=n;shSizeSum+=sz;
          const after=S.shots.length;shCap+=Math.max(0,shBefore+n-after);}
        else{spMade++;sizeSum+=sz;}
      }
      for(let k=q;k<OUTQ.length;k++){
        if(OUTQ[k].t==='merge')merged++;
        if(OUTQ[k].t==='ath')athHits++;
      }
      OUTQ.length=0;
    }
    const q2=OUTQ.length;
    const wd=S.dead;
    if(opt.trace){
      const drop=S.pxAth>0?Math.max(0,Math.min(1,1-S.px/S.pxAth)):0;
      if(S.silk>0.5&&!opt.__hit){opt.__hit=1;
        console.log(`  >> silk=${S.silk.toFixed(3)} drop=${drop.toFixed(4)} debt=${S.debt.toFixed(4)} px=${S.px} pxAth=${S.pxAth} bites=${S.bites} step=${st}`);}
    }
    const shPre=S.shots.length;
    simStep();
    for(let k=0;k<OUTQ.length;k++){
      const t=OUTQ[k].t;
      if(t==='bite')cumBites++;
      else if(t==='kill')cumKills++;
      else if(t==='hit'||t==='spark')shHit++;
    }
    OUTQ.length=0;
    if(!wd&&S.dead)deaths++;
    let al=0;for(const s of S.spiders)if(!s.dying)al++;
    if(al>maxSp)maxSp=al;
    sumSp+=al;n++;
    if(S.shots.length>maxSh)maxSh=S.shots.length;
    if(S.silk>peakSilk)peakSilk=S.silk;
  }
  const mins=lastStep*SIMC.STEP_MS/60000;
  return{shMade,shHit,shCap,spMade,avgSpSize:spMade?sizeSum/spMade:0,avgShSize:shMade?shSizeSum/shMade:0,mins,dust,ent,merged,maxSp,avgSp:sumSp/n,maxSh,deaths,athHits,
    kills:cumKills,bites:cumBites,gen:S.gen,px:S.px,pxAth:S.pxAth,
    silk:S.silk,peakSilk,debt:S.debt};
}
const D=JSON.parse(fs.readFileSync(process.env.FIX||require('path').join(__dirname,'fixtures','real-pools.json'),'utf8'));
if(process.env.TRACE){
  for(const n of process.env.TRACE.split(',')){
    console.log('=== '+n);
    run(D.trades[n],{trace:true});
  }
  process.exit(0);
}
const rows=[];
for(const [name,ev] of Object.entries(D.trades)){
  const r=run(ev);
  const dd=(1-r.px/r.pxAth)*100;
  const ic=r.kills+r.bites?r.kills/(r.kills+r.bites)*100:100;
  rows.push({name,h1:parseFloat(D.meta[name].h1),...r,dd,ic});
}
rows.sort((x,y)=>(isFinite(x.h1)?x.h1:0)-(isFinite(y.h1)?y.h1:0));
if(process.env.SHOTECON){
  console.log('token            spiders  shots     hits     dropped  avg.size(spd/shot)    intercept');
  console.log('─'.repeat(92));
  for(const r of rows){
    console.log(r.name.padEnd(16)+
      String(r.spMade).padStart(8)+String(r.shMade).padStart(10)+
      String(r.shHit).padStart(9)+String(r.shCap).padStart(9)+
      (r.avgSpSize.toFixed(2)+' / '+r.avgShSize.toFixed(2)).padStart(22)+
      (r.ic.toFixed(0)+'%').padStart(10));
  }
  process.exit(0);
}
console.log('token            h1%   window tx/min  ent/dust  spiders(max/avg)   intercept  bite  drawdown  SILK(peak)  death');
console.log('─'.repeat(112));
for(const r of rows){
  const txm=(r.ent+r.dust)/r.mins;
  console.log(
    r.name.padEnd(16)+
    String(isFinite(r.h1)?r.h1.toFixed(1):'?').padStart(6)+
    (r.mins.toFixed(0)+'min').padStart(7)+
    txm.toFixed(0).padStart(7)+
    (r.ent+'/'+r.dust).padStart(10)+
    (r.maxSp+'/'+r.avgSp.toFixed(1)).padStart(19)+
    (r.ic.toFixed(0)+'%').padStart(10)+
    String(r.bites).padStart(6)+
    (r.dd.toFixed(1)+'%').padStart(10)+
    (r.silk.toFixed(2)+'/'+r.peakSilk.toFixed(2)).padStart(12)+
    String(r.deaths).padStart(8));
}
