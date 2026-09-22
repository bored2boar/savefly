#!/usr/bin/env node
/* A1, A2: frame time under different load and in the worst weather. */
const {createCanvas}=require('canvas');
const fs=require('fs'),path=require('path');
function bench(label,setup,frames){
  let src=fs.readFileSync(path.join(__dirname,'..','src','savefly.html'),'utf8')
    .split('<script>')[1].split('</script>')[0];
  src+=`\nglobalThis.__x={
    sim:()=>S, feed:()=>FEED, wx:(v)=>{wx=v;wxT=v;skyKey=-1;mkBgTile();mkFgTile();
      for(const c of clouds)cloudTile(c,skyRamp(wx),wx);},
    bolt:()=>{bolt=mkBolt();flash=1;},
    spider:(n,sz)=>{for(let i=0;i<n;i++)simSpawnSpider(sz,90+i);},
    shot:(n)=>{for(let i=0;i<n;i++)simFireShot(.8,80+i);},
    silk:(v)=>{S.silk=v;},
    sy:()=>syncing, boot:()=>booting};`;
  const param=()=>({value:0,setValueAtTime(){return this},linearRampToValueAtTime(){return this},exponentialRampToValueAtTime(){return this},setTargetAtTime(){return this}});
  const anode=()=>({connect(){},disconnect(){},start(){},stop(){},loop:false,frequency:param(),gain:param(),Q:param(),type:'sine',buffer:null});
  global.AudioContext=function(){return{currentTime:0,sampleRate:48000,state:'running',destination:anode(),resume(){},createOscillator:anode,createGain:anode,createBiquadFilter:anode,createBufferSource:anode,createBuffer:(c,n)=>({getChannelData:()=>new Float32Array(n)})}};
  let fillN=0;
  function mkEl(){const c=createCanvas(1,1);
    c.addEventListener=()=>{};c.style={};c.classList={add(){},remove(){}};
    c.textContent='';c.innerHTML='';c.className='';c.value=50;
    c.insertBefore=()=>{};c.removeChild=()=>{};c.children={length:0};
    c.appendChild=()=>{};c.requestFullscreen=()=>{};
    const g=c.getContext.bind(c);
    c.getContext=function(t){const x=g(t);
      if(!x.__w){const o=x.fillRect.bind(x);x.fillRect=(...a)=>{fillN++;return o(...a);};x.__w=1;}
      return x;};
    return c;}
  const store={};
  global.document={getElementById(id){if(!store[id])store[id]=mkEl();return store[id]},
    createElement(){return mkEl()},addEventListener(){},fullscreenElement:null,exitFullscreen(){}};
  global.window={AudioContext:global.AudioContext};
  let n=0,ts=[],f0=0,armed=false,done=false;
  global.requestAnimationFrame=(cb)=>{
    if(done)return;
    setImmediate(()=>{
      n++;
      const X=global.__x;
      if(X&&!armed&&X.sy()===0&&!X.boot()&&n>10){armed=true;setup(X);f0=fillN;}
      if(armed&&n%20===0){const X2=global.__x;if(X2.sim().spiders.length<2)setup(X2);}
      if(armed)ts.push(process.hrtime.bigint());
      if(armed&&ts.length>frames){done=true;return;}
      cb(Date.now());
    });
  };
  eval(src);
  return new Promise(res=>{
    const iv=setInterval(()=>{
      if(done){
        clearInterval(iv);
        let s=0n;for(let i=1;i<ts.length;i++)s+=ts[i]-ts[i-1];
        res({label,ms:Number(s)/1e6/Math.max(1,ts.length-1),
          fill:Math.round((fillN-f0)/Math.max(1,ts.length))});
      }
    },20);
    setTimeout(()=>{done=true;},60000);
  });
}
(async()=>{
  const cases=[
    ['A1 calm: 0 spiders 0 shots',(X)=>{X.silk(0.05);}],
    ['A1 4 spiders 10 shots',(X)=>{X.spider(4,1.2);X.shot(10);}],
    ['A1 12 spiders 40 shots',(X)=>{X.spider(12,2.0);X.shot(40);}],
    ['A1 silk 0.9 + 12 spiders',(X)=>{X.silk(0.9);X.spider(12,2.4);X.shot(40);}],
    ['A2 storm: rain + 12 spiders',(X)=>{X.wx(0.75);X.spider(12,2.0);X.shot(40);}],
    ['A2 night: downpour + lightning',(X)=>{X.wx(0.97);X.bolt();X.spider(12,2.4);X.shot(40);}],
  ];
  console.log();
  for(const [label,fn] of cases){
    const r=await bench(label,fn,140);
    const bad=r.ms>5;
    console.log('  '+(bad?'WARN':'ok  ')+'  '+label.padEnd(36)+
      r.ms.toFixed(2).padStart(7)+' ms   '+String(r.fill).padStart(6)+' fillRect');
  }
  console.log('\n  (cairo CPU; in the browser upscale and compositing run on the GPU)');
})();
