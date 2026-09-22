#!/usr/bin/env node
/* Header check on a live deployment.
   A config nobody tested on a real server is just
   text. This checks what actually breaks the game:
     - meta.json cached -> clients do not see shard rotation
       and silently lose the feed
     - no Content-Range in Expose-Headers -> Range resumption in
       the browser does not work, the client pulls the whole tail every time
     - no Accept-Ranges -> same thing

   node tools/headers-check.js https://savefly.example
*/
const BASE=(process.argv[2]||'http://localhost:8099').replace(/\/$/,'');
let fails=0,warns=0;
const T=(ok,name,info)=>{
  if(ok)console.log('  PASS  '+name);
  else{fails++;console.log('  FAIL  '+name+(info?'  -> '+info:''));}
};
const W=(ok,name,info)=>{
  if(!ok){warns++;console.log('  warning '+name+(info?'  -> '+info:''));}
};
async function head(p,extra){
  const r=await fetch(BASE+p,{headers:extra||{},cache:'no-store'});
  const h={};r.headers.forEach((v,k)=>h[k.toLowerCase()]=v);
  return {status:r.status,h,body:r};
}
(async()=>{
  console.log('base:',BASE);
  console.log();
  // 1. meta.json must not be cached
  try{
    const {status,h}=await head('/data/meta.json');
    T(status===200,'meta.json available','HTTP '+status);
    const cc=h['cache-control']||'';
    T(/no-cache|no-store|max-age=0/.test(cc),
      'meta.json is not cached',
      'Cache-Control: '+(cc||'missing')+' - a CDN will cache the shard list, clients will lose the feed');
  }catch(e){T(false,'meta.json','unavailable: '+e.message);}

  // 2. Range works and Content-Range is visible
  let shard=null;
  try{
    const r=await fetch(BASE+'/data/meta.json',{cache:'no-store'});
    const m=await r.json();
    shard=(m.shards||[]).slice(-1)[0];
  }catch(e){}
  if(!shard){T(false,'tail shard found','meta.shards is empty');}
  else{
    const p=shard.indexOf('/')>=0?('/data/'+shard):('/data/events/'+shard);
    try{
      const full=await head(p);
      T(full.status===200,'shard available',p+' -> HTTP '+full.status);
      const ar=full.h['accept-ranges']||'';
      T(/bytes/.test(ar),'Accept-Ranges: bytes','got: '+(ar||'missing'));
      const part=await head(p,{Range:'bytes=10-40'});
      T(part.status===206,'Range returns 206','HTTP '+part.status);
      T(!!part.h['content-range'],'Content-Range present');
      const exp=(part.h['access-control-expose-headers']||'').toLowerCase();
      T(exp.includes('content-range'),
        'Content-Range in Expose-Headers',
        'got: '+(exp||'missing')+' - without it the browser cannot see the header and Range resumption fails');
      W(/no-cache|max-age=0/.test(full.h['cache-control']||''),
        'tail shard is cached',
        'Cache-Control: '+(full.h['cache-control']||'missing')+' - it grows, a cache will serve a stale tail');
    }catch(e){T(false,'shard','error: '+e.message);}
  }

  // 3. state.json
  try{
    const {status,h}=await head('/data/state.json');
    T(status===200,'state.json available','HTTP '+status);
    const ma=/max-age=(\d+)/.exec(h['cache-control']||'');
    W(!ma||+ma[1]<=30,'state.json cached for too long',
      'Cache-Control: '+(h['cache-control']||'missing'));
  }catch(e){W(false,'state.json unavailable','cold start will be slow: '+e.message);}

  // 4. CORS
  try{
    const {h}=await head('/data/meta.json');
    W(!!h['access-control-allow-origin'],'no Access-Control-Allow-Origin',
      'needed if the data is on another domain');
  }catch(e){}

  console.log();
  console.log(fails?`HEADERS: ${fails} problems, ${warns} warnings`
    :`HEADERS: everything critical is in place${warns?', warnings '+warns:''}`);
  process.exit(fails?1:0);
})().catch(e=>{console.log('ERR',e.message);process.exit(1);});
