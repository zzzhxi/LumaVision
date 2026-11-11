import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { createStore, limits } from '../storage.mjs';

const parent=resolve('test-results');
await mkdir(parent,{recursive:true});
const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
const CAPTCHA='ABC234',PASSWORD='Pass1234';
function metadata(overrides={}){return {id:`work-${randomUUID()}`,requestId:randomUUID(),revision:0,title:'多图上传回归测试',prompt:'A quiet scene, soft light.',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[],...overrides};}
async function setup(t){
  const dir=await mkdtemp(join(parent,'uploads-test-'));
  const codes=new Map();
  const options={storageRoot:dir,sendAuthCode:async({email,code,purpose})=>{codes.set(email,code);codes.set(`${purpose}:${email}`,code);return {delivery:'email'};},captchaFactory:()=>({text:CAPTCHA,image:Buffer.from('captcha')}),registrationEmailDomains:null};
  let app=await createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const url=()=>`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));const target=resolve(dir);assert.ok(target.startsWith(parent+sep)&&target.includes('uploads-test-'));await rm(target,{recursive:true,force:true});});
  return {dir,codes,captcha:CAPTCHA,get store(){return app.store;},get auth(){return app.auth;},url,async restart(){await new Promise(resolve=>app.server.close(resolve));app=await createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');}};
}
async function login(env,email){
  const headers={'Content-Type':'application/json'};
  let response=await fetch(env.url()+'/api/auth/login',{method:'POST',headers,body:JSON.stringify({email,password:PASSWORD})});
  if(response.status===401){
    const challenge=await fetch(env.url()+'/api/auth/code',{method:'POST',headers,body:JSON.stringify({email})}).then(item=>item.json());
    const captcha=await fetch(env.url()+'/api/auth/captcha').then(item=>item.json());
    response=await fetch(env.url()+'/api/auth/register',{method:'POST',headers,body:JSON.stringify({email,code:env.codes.get(`register:${email}`),challengeId:challenge.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:env.captcha})});
  }
  assert.equal(response.status,200);
  const data=await response.json();
  await env.auth.requestCreator(data.user.id,{social:{instagram:`https://instagram.com/${email.split('@')[0]}`}});
  await env.auth.reviewCreator(data.user.id,{decision:'approve'});
  return {cookie:response.headers.get('set-cookie').split(';')[0],user:data.user};
}
async function post(env,meta,files=[],headers={}){
  const form=new FormData();form.set('metadata',JSON.stringify(meta));files.forEach(file=>form.append('files',file));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers,body:form});return {status:response.status,body:await response.json()};
}
async function review(env,id,decision,headers){
  const expectedRevision=(await env.store.get(id)).revision;
  return fetch(env.url()+`/api/admin/works/${id}/review`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({decision,expectedRevision})});
}
const jpg=(name='photo.jpg')=>new File([picture],name,{type:'image/jpeg'});

test('multiple images persist across server restart, preserve bytes and ordered cover on edit',async t=>{
  const env=await setup(t),meta=metadata({media:[{file:0},{file:1}]});
  const {cookie}=await login(env,'owner@test.dev');const auth={cookie};
  const first=await post(env,meta,[jpg('第一张.jpg'),jpg('第二张.jpg')],auth);assert.equal(first.status,200);assert.equal(first.body.work.media.length,2);
  assert.equal(first.body.work.status,'pending');assert.match(first.body.work.authorId,/^user-/);
  const repeated=await post(env,meta,[jpg('第一张.jpg'),jpg('第二张.jpg')],auth);assert.equal(repeated.body.work.revision,1);assert.equal((await env.store.list()).length,0);
  assert.equal((await review(env,first.body.work.id,'approve',auth)).status,200);assert.equal((await env.store.list()).length,1);
  await env.restart();const list=await fetch(env.url()+'/api/works').then(r=>r.json());assert.equal(list.works[0].title,meta.title);assert.equal(list.works[0].media[1].name,'第二张.jpg');
  const original=list.works[0];const image=await fetch(env.url()+original.media[0].url);assert.deepEqual(Buffer.from(await image.arrayBuffer()),picture);
  const edit=await post(env,{...meta,requestId:randomUUID(),revision:original.revision,title:'更新后的相册',media:[{existing:original.media[1].id},{existing:original.media[0].id}]},[],auth);assert.equal(edit.status,200);assert.equal(edit.body.work.media[0].id,original.media[1].id);
  assert.equal(edit.body.work.status,'pending');
  assert.equal((await review(env,first.body.work.id,'approve',auth)).status,200);
  const stale=await post(env,{...meta,requestId:randomUUID(),revision:1,media:[]},[],auth);assert.equal(stale.status,409);assert.equal((await env.store.list())[0].title,'更新后的相册');
});

test('real WebM upload, mixed gallery, byte ranges and archive/restore',async t=>{
  const env=await setup(t);
  const {cookie}=await login(env,'owner@test.dev');const auth={cookie};
  const video=await readFile(new URL('./fixtures/flower.webm',import.meta.url));
  const result=await post(env,metadata({media:[{file:0},{file:1}]}),[jpg(),new File([video],'flower.webm',{type:'video/webm'})],auth);assert.equal(result.status,200);const work=result.body.work;assert.equal(work.type,'video');
  const range=await fetch(env.url()+work.media[1].url,{headers:{cookie,Range:'bytes=0-31'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-type'),'video/webm');assert.deepEqual(Buffer.from(await range.arrayBuffer()),video.subarray(0,32));
  const suffix=await fetch(env.url()+work.media[1].url,{headers:{cookie,Range:'bytes=-5'}});assert.deepEqual(Buffer.from(await suffix.arrayBuffer()),video.subarray(-5));
  assert.equal((await fetch(env.url()+work.media[1].url,{headers:{cookie,Range:'bytes=99999999-'}})).status,416);
  const archived=await fetch(env.url()+'/api/works/'+work.id,{method:'DELETE',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:work.revision})}).then(r=>r.json());assert.equal((await env.store.list()).length,0);
  await env.restart();assert.equal((await env.store.list()).length,0);
  const restored=await fetch(env.url()+'/api/works/'+work.id+'/restore',{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:archived.work.revision})});assert.equal(restored.status,200);
  const restoredWork=await env.store.get(work.id);assert.equal(restoredWork.media.length,2);
});

test('reject unsafe or malformed uploads without partially publishing files',async t=>{
  const env=await setup(t);
  const {cookie}=await login(env,'owner@test.dev');const auth={cookie};
  let result=await post(env,metadata({media:[{file:0},{file:1}]}),[jpg(),new File(['<script>alert(1)</script>'],'bad.jpg',{type:'image/jpeg'})],auth);assert.equal(result.status,415);assert.equal((await env.store.list()).length,0);assert.equal((await readdir(join(env.dir,'media'))).length,0);
  result=await post(env,metadata({media:[{file:0}]}),[new File([picture],'wrong.png',{type:'image/png'})],auth);assert.equal(result.status,415);
  result=await post(env,metadata({media:[{file:0}]}),[],auth);assert.equal(result.status,400);
  result=await post(env,metadata({media:[{existing:'../../outside'}]}),[],auth);assert.equal(result.status,400);
  result=await post(env,metadata({prompt:' '}),[],auth);assert.equal(result.status,400);
  result=await post(env,metadata({media:Array.from({length:13},()=>({file:0}))}),[jpg()],auth);assert.equal(result.status,400);
  result=await post(env,metadata(),[],{cookie,Origin:'https://unrelated.example'});assert.equal(result.status,403);
  result=await post(env,metadata());assert.equal(result.status,401);
  assert.equal((await fetch(env.url()+'/data/works/anything.json')).status,404);
  assert.equal((await fetch(env.url()+'/media/..%2F..%2Fpackage.json')).status,404);
});

test('limits and simultaneous edits do not silently overwrite a saved work',async t=>{
  const env=await setup(t);
  const {cookie}=await login(env,'owner@test.dev');const auth={cookie};
  await assert.rejects(env.store.save(metadata({media:[{file:0}]}),[{size:limits.video+1,arrayBuffer(){throw Error('must not read oversized file');}}]),error=>error.status===413);
  const first=await post(env,metadata(),[],auth);assert.equal(first.status,200);const work=first.body.work;
  assert.equal((await review(env,work.id,'approve',auth)).status,200);
  const updates=await Promise.all(['A','B'].map(title=>post(env,{...work,revision:work.revision+1,title,requestId:randomUUID(),media:[]},[],auth)));
  assert.deepEqual(updates.map(r=>r.status).sort(),[200,409]);
  assert.equal((await review(env,work.id,'approve',auth)).status,200);assert.equal((await env.store.list())[0].revision,4);
});

test('corrupt records are skipped in lists, malformed requests return 400, deleted works cannot be re-reviewed',async t=>{
  const env=await setup(t);
  const {cookie}=await login(env,'owner@test.dev');const auth={cookie}; // 首位用户即管理员
  // README 兼容承诺：无 authorId/status 的历史作品视为已发布，登录用户可管理
  const legacy={id:`work-${randomUUID()}`,title:'历史作品',prompt:'legacy prompt',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[],tags:['自然风光'],likes:0,custom:true,uploaded:true,revision:1,requestId:null,created:Date.now(),updated:Date.now()};
  await writeFile(join(env.dir,'works',`${legacy.id}.json`),JSON.stringify(legacy));
  assert.equal((await fetch(env.url()+'/api/works').then(r=>r.json())).works.length,1);
  assert.equal((await fetch(env.url()+'/api/works/'+legacy.id,{method:'DELETE',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:legacy.revision})})).status,200);
  // 单个损坏记录只影响自身：列表跳过而不是整体 500
  await writeFile(join(env.dir,'works',`work-${randomUUID()}.json`),'{broken json');
  assert.equal((await fetch(env.url()+'/api/works').then(r=>r.json())).works.length,0);
  // 畸形 URL 与 JSON null 请求体返回 400 而不是 500
  assert.equal((await fetch(env.url()+'/%')).status,400);
  assert.equal((await fetch(env.url()+`/api/works/${legacy.id}/restore`,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:'null'})).status,400);
  // 已删除（仍处 pending）的作品不能被审核通过
  const work=(await post(env,metadata(),[],auth)).body.work;
  await fetch(env.url()+'/api/works/'+work.id,{method:'DELETE',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:work.revision})});
  assert.equal((await review(env,work.id,'approve',auth)).status,409);
});

test('admin edits preserve the original author attribution',async t=>{
  const env=await setup(t);
  const admin=await login(env,'admin@test.dev');
  const {cookie}=await login(env,'author@test.dev');
  const work=(await post(env,metadata(),[],{cookie})).body.work;
  const edit=await post(env,{...work,requestId:randomUUID(),media:[]},[],{cookie:admin.cookie});
  assert.equal(edit.status,200);
  assert.equal(edit.body.work.authorId,work.authorId);
  assert.equal(edit.body.work.author,work.author);
});

test('publishing drafts persist privately with attachments, then submit for review without duplicating work',async t=>{
  const env=await setup(t);
  const {cookie,user}=await login(env,'draft-owner@test.dev');const headers={cookie};
  const meta=metadata({intent:'draft',title:'',prompt:'',media:[{file:0},{file:1}]});
  const first=await post(env,meta,[jpg('封面.jpg'),jpg('参考.jpg')],headers);
  assert.equal(first.status,200);const draft=first.body.work;
  assert.equal(draft.status,'draft');assert.equal(draft.title,'未命名作品');assert.equal(draft.media.length,2);
  const retry=await post(env,meta,[jpg(),jpg()],headers);assert.equal(retry.body.work.revision,1);
  assert.equal((await env.store.list()).length,0);assert.equal((await env.store.listByStatus('pending')).length,0);
  assert.equal((await env.store.listByAuthor(user.id))[0].status,'draft');
  assert.equal((await review(env,draft.id,'approve',headers)).status,409);
  assert.equal((await fetch(env.url()+draft.media[0].url)).status,404);
  const privatePhoto=await fetch(env.url()+draft.media[0].url,{headers});assert.equal(privatePhoto.status,200);
  assert.equal(privatePhoto.headers.get('cache-control'),'private, no-store');assert.deepEqual(Buffer.from(await privatePhoto.arrayBuffer()),picture);
  await env.restart();assert.equal((await env.store.listByAuthor(user.id))[0].media[1].name,'参考.jpg');
  const edit=await post(env,{...meta,requestId:randomUUID(),revision:1,title:'继续编辑',prompt:'',media:[{existing:draft.media[1].id}]},[],headers);
  assert.equal(edit.status,200);assert.equal(edit.body.work.status,'draft');assert.equal(edit.body.work.media[0].id,draft.media[1].id);
  assert.equal((await fetch(env.url()+draft.media[0].url)).status,404);
  assert.equal((await post(env,{...meta,revision:1,requestId:randomUUID(),media:[]},[],headers)).status,409);
  const incomplete=await post(env,{...meta,intent:'submit',revision:2,requestId:randomUUID(),media:[{existing:draft.media[1].id}]},[],headers);
  assert.equal(incomplete.status,400);assert.equal((await env.store.get(draft.id)).status,'draft');
  const submit=await post(env,{...meta,intent:'submit',revision:2,requestId:randomUUID(),title:'完成作品',prompt:'已准备好的提示词',media:[{existing:draft.media[1].id}]},[],headers);
  assert.equal(submit.status,200);assert.equal(submit.body.work.id,draft.id);assert.equal(submit.body.work.status,'pending');
  assert.equal((await env.store.list()).length,0);assert.equal((await env.store.listByAuthor(user.id)).length,1);
  assert.equal((await review(env,draft.id,'approve',headers)).status,200);
  assert.equal((await env.store.list()).length,1);assert.equal((await fetch(env.url()+draft.media[1].url)).status,200);
  assert.equal((await fetch(env.url()+draft.media[0].url)).status,404);
  assert.equal((await post(env,{...meta,revision:3,requestId:randomUUID(),media:[]},[],headers)).status,409);
});

test('draft management rejects other users and preserves private media through remove/restore',async t=>{
  const env=await setup(t);const {cookie}=await login(env,'private-owner@test.dev');
  const first=await post(env,metadata({intent:'draft',media:[{file:0}]}),[jpg()],{cookie});const work=first.body.work;
  const stranger=await login(env,'private-stranger@test.dev');
  assert.equal((await post(env,{...work,intent:'draft',requestId:randomUUID(),media:[]},[],{cookie:stranger.cookie})).status,403);
  assert.equal((await fetch(env.url()+work.media[0].url,{headers:{cookie:stranger.cookie}})).status,404);
  assert.equal((await fetch(env.url()+'/api/user/works',{headers:{cookie:stranger.cookie}}).then(r=>r.json())).works.length,0);
  assert.equal((await fetch(env.url()+'/api/users/'+work.authorId+'/works').then(r=>r.json())).works.length,0);
  const remove=await fetch(env.url()+'/api/works/'+work.id,{method:'DELETE',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:work.revision})});
  assert.equal(remove.status,200);const removed=(await remove.json()).work;
  assert.equal((await env.store.listByAuthor(work.authorId)).length,0);assert.equal((await fetch(env.url()+work.media[0].url)).status,404);
  const restore=await fetch(env.url()+'/api/works/'+work.id+'/restore',{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify({revision:removed.revision})});
  assert.equal(restore.status,200);assert.equal((await restore.json()).work.status,'draft');assert.equal((await env.store.list()).length,0);
  assert.equal((await env.store.listByAuthor(work.authorId)).length,1);
  const invalid=await post(env,metadata({intent:'draft',media:[{file:0}]}),[new File(['invalid'],'bad.jpg',{type:'image/jpeg'})],{cookie});
  assert.equal(invalid.status,415);
});
