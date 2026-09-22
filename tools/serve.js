#!/usr/bin/env node
/* Local static server with Range support - to test
   csv mode the way it will behave on any CDN. */
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..'),PORT=+(process.argv[2]||8080);
const MIME={'.html':'text/html','.js':'text/javascript','.json':'application/json',
  '.csv':'text/csv','.png':'image/png','.md':'text/markdown'};
/* Headers are the same as in deploy/nginx.conf.
   This is not cosmetic: without Content-Range in Expose-Headers the browser
   cannot see the header and Range resumption silently fails - the client pulls
   the whole tail shard every time. And a cached meta.json means the
   client never sees shard rotation and loses the feed.
   So the dev server must behave like prod, otherwise
   a local browser test checks the wrong thing. */
function policy(p){
  if(/\/meta\.json$/.test(p))return 'no-cache, must-revalidate';
  if(/\/state\.json$/.test(p))return 'public, max-age=5';
  if(/\/archive\//.test(p))return 'public, max-age=31536000, immutable';
  if(/\/events\//.test(p))return 'no-cache';
  if(/\.html$/.test(p))return 'public, max-age=60';
  return 'no-cache';
}
const EXPOSE='Content-Range, Accept-Ranges, Content-Length';
http.createServer((req,res)=>{
  let p=decodeURIComponent(req.url.split('?')[0]);
  if(p==='/')p='/src/index.html';        // landing at the root
  if(p==='/play')p='/src/savefly.html';
  const f=path.join(ROOT,p);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){
    res.writeHead(404);return res.end('not found');}
  const size=fs.statSync(f).size;
  const type=MIME[path.extname(f)]||'application/octet-stream';
  const range=req.headers.range;
  if(range){
    const m=/bytes=(\d+)-(\d*)/.exec(range);
    const start=+m[1],end=m[2]?+m[2]:size-1;
    if(start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`,
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Expose-Headers':EXPOSE});return res.end();}
    res.writeHead(206,{'Content-Type':type,'Accept-Ranges':'bytes',
      'Content-Range':`bytes ${start}-${end}/${size}`,
      'Content-Length':end-start+1,
      'Cache-Control':policy(p),
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Expose-Headers':EXPOSE});
    return fs.createReadStream(f,{start,end}).pipe(res);
  }
  res.writeHead(200,{'Content-Type':type,'Accept-Ranges':'bytes',
    'Content-Length':size,
    'Cache-Control':policy(p),
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Expose-Headers':EXPOSE});
  fs.createReadStream(f).pipe(res);
}).listen(PORT,()=>console.log(`static files from ${ROOT} on http://localhost:${PORT}`));
