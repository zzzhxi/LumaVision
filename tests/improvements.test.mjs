import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.mjs';
import { createStore } from '../storage.mjs';
import { createAuthStore } from '../auth.mjs';
import { queryWorks } from '../work-query.mjs';
import { Readable } from 'node:stream';
import { readMultipart } from '../multipart.mjs';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createRecordIndex } from '../record-index.mjs';

const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
const meta=(extra={})=>({id:'work-'+randomUUID(),revision:0,requestId:randomUUID(),title:'边界测试',prompt:'private prompt',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[{file:0}],...extra});
async function setup(t){
  const dir=await mkdtemp(join(tmpdir(),'lumavision-improvements-'));
  const app=await createApp({storageRoot:dir,sendAuthCode:async()=>({delivery:'email'})});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const admin=await app.auth.upsertByEmail('admin@test.dev'),author=await app.auth.upsertByEmail('author@test.dev'),other=await app.auth.upsertByEmail('other@test.dev');
  const cookies={};for(const user of [admin,author,other])cookies[user.id]='luma_session='+(await app.auth.createSession(user.id)).token;
  const url=`http://127.0.0.1:${app.server.address().port}`;
  return {...app,dir,admin,author,other,cookies,url};
}
const save=(env,metadata,actor=env.author)=>env.store.save(metadata,[new File([picture],'photo.jpg',{type:'image/jpeg'})],actor);

test('pending/rejected/withdrawn/deleted media enforce GET, HEAD and Range; corruption and orphans never release bytes',async t=>{
  const env=await setup(t);
  let work=await save(env,meta());const path=work.media[0].url;
  for(const status of ['pending','rejected','withdrawn']){
    work={...work,status};await writeFile(join(env.dir,'works',work.id+'.json'),JSON.stringify(work));
    for(const method of ['GET','HEAD'])for(const range of [false,true]){
      const headers=range?{Range:'bytes=0-11'}:{};
      assert.equal((await fetch(env.url+path,{method,headers})).status,404);
      assert.equal((await fetch(env.url+path,{method,headers:{...headers,cookie:env.cookies[env.other.id]}})).status,404);
      for(const user of [env.author,env.admin]){
        const response=await fetch(env.url+path,{method,headers:{...headers,cookie:env.cookies[user.id]}});
        assert.equal(response.status,range?206:200);assert.equal(response.headers.get('cache-control'),'private, no-store');
      }
    }
  }
  await writeFile(join(env.dir,'works',work.id+'.json'),JSON.stringify({...work,status:'published',deletedAt:Date.now()}));
  assert.equal((await fetch(env.url+path)).status,404);
  await writeFile(join(env.dir,'works',work.id+'.json'),'{broken');
  for(const method of ['GET','HEAD'])assert.ok([404,500].includes((await fetch(env.url+path,{method,headers:{Range:'bytes=0-11'}})).status));
  const orphan=randomUUID()+'.jpg';await writeFile(join(env.dir,'media',orphan),picture);
  assert.equal((await fetch(env.url+'/media/'+orphan)).status,404);
});

test('old review conflicts; successful review advances revision and duplicate decisions conflict',async t=>{
  const env=await setup(t),first=await save(env,meta());
  const updated=await env.store.save({...first,title:'unseen v2',requestId:randomUUID(),media:first.media.map(item=>({existing:item.id}))},[],env.author);
  const review=expectedRevision=>fetch(env.url+'/api/admin/works/'+first.id+'/review',{method:'POST',headers:{cookie:env.cookies[env.admin.id],'Content-Type':'application/json'},body:JSON.stringify({decision:'approve',expectedRevision})});
  assert.equal((await review(first.revision)).status,409);assert.equal((await review(undefined)).status,400);
  const response=await review(updated.revision);assert.equal(response.status,200);const published=(await response.json()).work;
  assert.equal(published.revision,updated.revision+1);assert.equal((await review(updated.revision)).status,409);
  assert.equal((await env.store.list())[0].title,'unseen v2');
});

test('source is atomic and survives author editing; browser source declarations are ignored; retired attachments follow withdrawal',async t=>{
  const env=await setup(t),source={platform:'x',account:'example',tweetId:'1234567890123',url:'https://x.com/example/status/1234567890123',date:'2026-09-16'};
  const first=await save(env,meta(),{...env.author,importSource:source,importCreated:123});
  assert.equal(first.status,'published');assert.deepEqual((await env.store.get(first.id)).source,source);
  const updated=await env.store.save({...first,source:{account:'spoof'},title:'人工编辑',requestId:randomUUID(),media:[]},[],env.author);
  assert.deepEqual(updated.source,source);assert.ok(updated.historyMediaIds.includes(first.media[0].id));
  const published=await env.store.review(first.id,{decision:'approve',expectedRevision:updated.revision});
  assert.equal((await fetch(env.url+first.media[0].url)).status,200);
  await env.store.withdraw(first.id,published.revision,env.author.id);
  assert.equal((await fetch(env.url+first.media[0].url,{headers:{Range:'bytes=0-11'}})).status,404);
  const spoof=await save(env,meta({source}));assert.equal(spoof.source,undefined);
});

test('public cache revalidation happens after permission checks and private detail reads are gated',async t=>{
  const env=await setup(t),pending=await save(env,meta());
  assert.equal((await fetch(env.url+'/api/works/'+pending.id)).status,404);
  assert.equal((await fetch(env.url+'/api/works/'+pending.id,{headers:{cookie:env.cookies[env.author.id]}})).status,200);
  const work=await env.store.review(pending.id,{decision:'approve',expectedRevision:pending.revision});
  const response=await fetch(env.url+work.media[0].url),etag=response.headers.get('etag');assert.ok(etag);
  assert.equal((await fetch(env.url+work.media[0].url,{headers:{'If-None-Match':etag}})).status,304);
  await env.store.withdraw(work.id,work.revision,env.author.id);
  assert.equal((await fetch(env.url+work.media[0].url,{headers:{'If-None-Match':etag}})).status,404);
});

test('stable filtered pagination has no duplicates or omissions and refuses changed snapshots',async t=>{
  const env=await setup(t);
  for(let i=0;i<45;i++)await env.store.save(meta({media:[],title:'work '+i,prompt:i%2?'needle':'other'}),[],{...env.author,importSource:{platform:'x',account:'example',tweetId:String(1234567890123+i),url:`https://x.com/example/status/${1234567890123+i}`}});
  let cursor=null,ids=[];
  do{
    const params=new URLSearchParams({limit:'7',cards:'1',q:'needle'});if(cursor)params.set('cursor',cursor);
    const response=await fetch(env.url+'/api/works?'+params);assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.total,22);assert.ok(data.works.every(work=>work.prompt===undefined&&work.source===undefined&&work.cardOnly));
    ids.push(...data.works.map(work=>work.id));cursor=data.nextCursor;
  }while(cursor);
  assert.equal(ids.length,22);assert.equal(new Set(ids).size,22);
  const params=new URLSearchParams({limit:'7'}),works=await env.store.list(),first=queryWorks(works,params);
  works[0]={...works[0],revision:works[0].revision+1};params.set('cursor',first.nextCursor);
  assert.throws(()=>queryWorks(works,params),{status:409});
});

test('slow/failing mail does not block profile/session writes; reservation prevents resend and preserves old codes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'lumavision-mail-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let release,entered,mode='fast',code;
  const auth=createAuthStore(dir,{sendCode:async input=>{code=input.code;if(mode==='slow'){entered();await new Promise(resolve=>release=resolve);}if(mode==='fail')throw Error('mail failed');return {delivery:'email'};},registrationEmailDomains:null});
  const user=await auth.upsertByEmail('user@test.dev'),now=Date.now(),old=await auth.requestCode(user.email,{purpose:'password'},now),oldCode=code;
  mode='slow';const started=new Promise(resolve=>entered=resolve),sending=auth.requestCode('slow@test.dev',now);await started;
  const update=await Promise.race([auth.updateProfile(user.id,{nickname:'updated'}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('mail blocks writes')),1000);timer.unref();})]);assert.equal(update.nickname,'updated');
  await auth.destroySession((await auth.createSession(user.id)).token);
  await assert.rejects(auth.requestCode('slow@test.dev',now),{status:429});release();await sending;
  mode='fail';await assert.rejects(auth.requestCode(user.email,{purpose:'password'},now+60001),/mail failed/);
  assert.equal((await auth.changePassword(user.id,{code:oldCode,challengeId:old.challengeId,password:'Pass1234',now:now+60002})).id,user.id);
});

test('import authors never consume real administrator bootstrap in either creation order',async t=>{
  for(const importedFirst of [true,false]){
    const dir=await mkdtemp(join(tmpdir(),'lumavision-bootstrap-'));t.after(()=>rm(dir,{recursive:true,force:true}));const auth=createAuthStore(dir);
    if(importedFirst)assert.equal((await auth.upsertImportedAuthor('example','虚拟作者')).role,'user');
    assert.equal((await auth.upsertByEmail('real@test.dev')).role,'admin');
    assert.equal((await auth.upsertImportedAuthor('example','虚拟作者')).role,'user');
    await assert.rejects(auth.requestCode('example@import.lumavision.local'),{status:403});
  }
});

test('3000 records and six concurrent list reads retain accurate counts without unbounded file handles',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'lumavision-scale-'));const store=createStore(dir);await store.ready;
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<3000;i++){const work=meta({media:[],status:'published',created:i});await writeFile(join(dir,'works',work.id+'.json'),JSON.stringify(work));}
  const lists=await Promise.all(Array.from({length:6},()=>store.list()));assert.deepEqual(lists.map(list=>list.length),[3000,3000,3000,3000,3000,3000]);
});

test('streaming multipart preserves split boundaries/binary prefixes and cleans failed requests',async()=>{
  const boundary='test-boundary',binary=Buffer.concat([picture,Buffer.from('\r\n--test-boundaryXXbinary')]);
  const bytes=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),binary,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const chunks=[];for(let i=0;i<bytes.length;i+=137)chunks.push(bytes.subarray(i,i+137));
  const req=Readable.from(chunks);req.headers={'content-type':'multipart/form-data; boundary='+boundary};const upload=await readMultipart(req);
  try{assert.deepEqual(await readFile(upload.files[0].tempPath),binary);}finally{await upload.cleanup();}
  const before=(await readdir(tmpdir())).filter(name=>name.startsWith('lumavision-upload-')).sort();
  const truncated=Readable.from([bytes.subarray(0,-8)]);truncated.headers=req.headers;
  await assert.rejects(readMultipart(truncated),{status:400});
  assert.deepEqual((await readdir(tmpdir())).filter(name=>name.startsWith('lumavision-upload-')).sort(),before);
});

test('thumbnail bytes/cache validators inherit parent authorization, including a later withdrawal',async t=>{
  if(!process.env.LUMA_FFMPEG&&(process.platform!=='win32'||!await access(new URL('../tools/media/ffmpeg.exe',import.meta.url)).then(()=>true,()=>false))){t.skip('optional FFmpeg unavailable');return;}
  const env=await setup(t),work=await save(env,meta());
  const name=work.media[0].id,url=env.url+'/thumbnails/'+name+'/640.jpg';
  assert.equal((await fetch(url)).status,404);
  const response=await fetch(url,{headers:{cookie:env.cookies[env.author.id]}});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<picture.length);assert.equal(bytes[0],255);
  const published=await env.store.review(work.id,{decision:'approve',expectedRevision:work.revision});
  const publicResponse=await fetch(url),etag=publicResponse.headers.get('etag');assert.ok(etag);assert.equal((await fetch(url,{headers:{'If-None-Match':etag}})).status,304);
  await env.store.withdraw(work.id,published.revision,env.author.id);
  assert.equal((await fetch(url,{headers:{'If-None-Match':etag}})).status,404);
  assert.deepEqual(await readFile(join(env.dir,'media',name)),picture);
});

test('a slow decode does not block reviews; the delayed edit still observes the new revision',async t=>{
  const env=await setup(t),work=await save(env,meta());let release,entered;
  const started=new Promise(resolve=>entered=resolve);
  const saving=env.store.save({...work,requestId:randomUUID(),media:[{file:0}]},[{size:picture.length,type:'image/jpeg',async arrayBuffer(){entered();await new Promise(resolve=>release=resolve);return picture;}}],env.author);
  await started;
  const review=await env.store.review(work.id,{decision:'approve',expectedRevision:work.revision});assert.equal(review.status,'published');
  release();await assert.rejects(saving,{status:409});assert.equal((await readdir(join(env.dir,'media'))).length,1);
});

test('runtime metrics are administrator-only and contain no account or work text',async t=>{
  const env=await setup(t);
  assert.equal((await fetch(env.url+'/api/admin/metrics')).status,401);
  assert.equal((await fetch(env.url+'/api/admin/metrics',{headers:{cookie:env.cookies[env.author.id]}})).status,403);
  const response=await fetch(env.url+'/api/admin/metrics',{headers:{cookie:env.cookies[env.admin.id]}});assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.uploads.active,0);assert.equal(data.uploads.reservedBytes,0);assert.ok(data.memory.rss>0);
  assert.ok(!JSON.stringify(data).includes('@'));
});

test('unfinished uploads reserve capacity; excess requests fail and cancelled connections release it',async t=>{
  const env=await setup(t),requests=[];
  const before=(await readdir(tmpdir())).filter(name=>name.startsWith('lumavision-upload-')).sort();
  const wait=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await delay(10);}assert.fail('upload capacity did not settle');};
  for(let i=0;i<2;i++){
    const req=request(env.url+'/api/works',{method:'POST',headers:{cookie:env.cookies[env.admin.id],'Content-Type':'multipart/form-data; boundary=capacity','Content-Length':'1024'}});
    req.on('error',()=>{});req.on('response',response=>response.resume());
    req.write('--capacity\r\n');requests.push(req);
  }
  try{
    await wait(()=>env.metrics().uploads.active===2);assert.equal(env.metrics().uploads.reservedBytes,2048);
    const response=await fetch(env.url+'/api/works',{method:'POST',headers:{cookie:env.cookies[env.admin.id],'Content-Type':'multipart/form-data; boundary=capacity'},body:'--capacity--\r\n'});
    assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'2');
  }finally{requests.forEach(req=>req.destroy());}
  await wait(()=>env.metrics().uploads.active===0);assert.equal(env.metrics().uploads.reservedBytes,0);
  await wait(async()=>JSON.stringify((await readdir(tmpdir())).filter(name=>name.startsWith('lumavision-upload-')).sort())===JSON.stringify(before));
  assert.deepEqual((await readdir(tmpdir())).filter(name=>name.startsWith('lumavision-upload-')).sort(),before);
});

test('an injected disk read error fails index rebuilds and media authorization with a retryable response',async t=>{
  const env=await setup(t),draft=await save(env,meta()),work=await env.store.review(draft.id,{decision:'approve',expectedRevision:draft.revision});
  const target=join(env.dir,'works',work.id+'.json'),read=fsPromises.readFile,index=createRecordIndex(join(env.dir,'works'),/^work-[0-9a-f-]{36}$/);
  fsPromises.readFile=async function(path,...args){if(String(path)===target){const error=new Error('injected read fault');error.code='EIO';throw error;}return read.call(this,path,...args);};
  syncBuiltinESMExports();
  try{
    await assert.rejects(index.snapshot(),{code:'EIO'});
    const response=await fetch(env.url+work.media[0].url,{headers:{Range:'bytes=0-11'}});
    assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'2');assert.equal(response.headers.get('content-type'),'application/json; charset=utf-8');
  }finally{fsPromises.readFile=read;syncBuiltinESMExports();index.close();}
  assert.equal((await fetch(env.url+work.media[0].url)).status,200);
});
