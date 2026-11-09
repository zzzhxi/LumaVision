import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const parent=resolve('test-results');
await mkdir(parent,{recursive:true});
const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
async function setup(t){
  const dir=await mkdtemp(join(parent,'withdrawn-test-'));
  const options={storageRoot:dir,sendAuthCode:async()=>({delivery:'email'})};
  let app=await createApp(options);
  const listen=async()=>{app.server.listen(0,'127.0.0.1');await once(app.server,'listening');};
  await listen();
  t.after(async()=>{await new Promise(done=>app.server.close(done));assert.ok(resolve(dir).startsWith(parent+sep+'withdrawn-test-'));await rm(dir,{recursive:true,force:true});});
  const users={};
  for(const name of ['admin','creator','other']){
    let user=await app.auth.upsertByEmail(name+'@withdrawn.test',{nickname:name});
    user=await app.auth.completeOnboarding(user.id,{accountType:'creator',social:{x:'https://x.com/'+name}});
    await app.auth.reviewCreator(user.id,{decision:'approve'});
    const {token}=await app.auth.createSession(user.id);
    users[name]={user,cookie:'luma_session='+token};
  }
  return {dir,users,get store(){return app.store;},url:()=>`http://127.0.0.1:${app.server.address().port}`,async restart(){await new Promise(done=>app.server.close(done));app=await createApp(options);await listen();}};
}
async function api(env,path,actor,method='GET',body){
  const response=await fetch(env.url()+path,{method,headers:{'Content-Type':'application/json',...(actor?{cookie:env.users[actor].cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({}))};
}
async function seed(env,{actor='creator',intent='submit',unowned=false}={}){
  const work=await env.store.save({id:'work-'+randomUUID(),requestId:randomUUID(),revision:0,intent,title:'下架流程',prompt:'Quiet light above the ocean.',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[{file:0}]},[new File([picture],'a.jpg',{type:'image/jpeg'})],unowned?undefined:{id:env.users[actor].user.id,nickname:actor});
  return intent==='draft'?work:env.store.review(work.id,{decision:'approve',expectedRevision:work.revision});
}
async function edit(env,work,actor,intent,title='下架修改'){
  const form=new FormData();
  form.set('metadata',JSON.stringify({id:work.id,requestId:randomUUID(),revision:work.revision,intent,title,prompt:work.prompt,model:work.model,category:work.category,ratio:work.ratio,type:work.type,media:work.media.map(m=>({existing:m.id}))}));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie:env.users[actor].cookie},body:form});
  return {status:response.status,body:await response.json()};
}

test('管理员下架必填原因，公开隔离且仅作者列表收录，重启保留原因与媒体',async t=>{
  const env=await setup(t),work=await seed(env),path='/api/works/'+work.id+'/withdraw';
  assert.equal((await api(env,path,null,'POST',{revision:work.revision})).status,401);
  assert.equal((await api(env,path,'other','POST',{revision:work.revision})).status,403);
  assert.equal((await api(env,path,'creator','POST',{revision:work.revision-1})).status,409);
  assert.equal((await api(env,path,'creator','POST',{revision:'1'})).status,400);
  for(const note of [undefined,'   ',12,'a'.repeat(201)])assert.equal((await api(env,path,'admin','POST',{revision:work.revision,note})).status,400);
  assert.equal((await env.store.get(work.id)).status,'published');
  let result=await api(env,path,'admin','POST',{revision:work.revision,note:'  图片内容不符合发布规范  '});
  assert.equal(result.status,200);
  const down=result.body.work;
  assert.equal(down.status,'withdrawn');assert.equal(down.revision,work.revision+1);
  assert.equal(down.authorId,work.authorId);assert.equal(down.withdrawnBy,env.users.admin.user.id);
  assert.equal(down.withdrawnNote,'图片内容不符合发布规范');
  assert.equal((await api(env,path,'admin','POST',{revision:down.revision,note:'再次下架'})).status,403);
  result=await api(env,path,'creator','POST',{revision:down.revision});
  assert.equal(result.body.work.revision,down.revision);
  assert.equal((await api(env,'/api/works')).body.works.length,0);
  assert.equal((await api(env,`/api/users/${work.authorId}/works`)).body.works.length,0);
  assert.equal((await api(env,'/api/admin/works','admin')).body.works.length,0);
  assert.equal((await api(env,'/api/admin/works?status=withdrawn','admin')).body.works.length,1);
  assert.equal((await api(env,'/api/user/works','creator')).body.works[0].id,work.id);
  assert.equal((await api(env,'/api/user/works','admin')).body.works.length,0);
  const own=await seed(env,{actor:'admin'});
  assert.equal((await api(env,'/api/works/'+own.id+'/withdraw','admin','POST',{revision:own.revision})).status,400);
  const ownDown=await api(env,'/api/works/'+own.id+'/withdraw','admin','POST',{revision:own.revision,note:'自己作品暂时下架'});
  assert.equal(ownDown.status,200);assert.equal((await edit(env,ownDown.body.work,'admin','withdrawn')).status,200);
  assert.equal((await api(env,'/api/user/works','other')).body.works.length,0);
  for(const actor of [null,'other'])assert.equal((await fetch(env.url()+work.media[0].url,{headers:actor?{cookie:env.users[actor].cookie}:{}})).status,404);
  const media=await fetch(env.url()+work.media[0].url,{headers:{cookie:env.users.creator.cookie,Range:'bytes=0-19'}});
  assert.equal(media.status,206);assert.deepEqual(Buffer.from(await media.arrayBuffer()),picture.subarray(0,20));
  await env.restart();assert.equal((await env.store.get(work.id)).status,'withdrawn');
  assert.equal((await env.store.get(work.id)).withdrawnNote,down.withdrawnNote);
  assert.deepEqual((await api(env,'/api/user/works','admin')).body.works.map(w=>w.id),[own.id]);
});

test('下架作品编辑保持下架和作者归属；删除恢复仍下架，明确提交后重新审核',async t=>{
  const env=await setup(t),work=await seed(env);
  const down=(await api(env,'/api/works/'+work.id+'/withdraw','admin','POST',{revision:work.revision,note:'请修正图片说明'})).body.work;
  assert.equal((await edit(env,down,'other','withdrawn')).status,403);
  for(const intent of ['withdrawn','submit','draft'])assert.equal((await edit(env,down,'admin',intent)).status,403);
  assert.equal((await api(env,'/api/works/'+work.id,'admin','DELETE',{revision:down.revision})).status,403);
  let result=await edit(env,down,'creator','withdrawn');assert.equal(result.status,200);
  const saved=result.body.work;
  assert.equal(saved.status,'withdrawn');assert.equal(saved.title,'下架修改');assert.equal(saved.authorId,work.authorId);
  assert.equal(saved.withdrawnNote,down.withdrawnNote);
  assert.equal((await edit(env,down,'creator','withdrawn')).status,409);
  assert.equal((await api(env,'/api/works')).body.works.length,0);
  result=await api(env,'/api/works/'+work.id,'creator','DELETE',{revision:saved.revision});assert.equal(result.status,200);
  const removed=result.body.work;
  assert.equal((await api(env,'/api/user/works','admin')).body.works.length,0);
  assert.equal((await fetch(env.url()+work.media[0].url)).status,404);
  assert.equal((await api(env,'/api/works/'+work.id+'/withdraw','creator','POST',{revision:removed.revision})).status,409);
  assert.equal((await api(env,'/api/works/'+work.id+'/restore','admin','POST',{revision:removed.revision})).status,403);
  result=await api(env,'/api/works/'+work.id+'/restore','creator','POST',{revision:removed.revision});assert.equal(result.status,200);
  const restored=result.body.work;assert.equal(restored.status,'withdrawn');
  assert.equal((await api(env,'/api/user/works','admin')).body.works.length,0);
  assert.deepEqual(await readFile(join(env.dir,'media',work.media[0].id)),picture);
  result=await edit(env,restored,'creator','submit');assert.equal(result.status,200);
  assert.equal(result.body.work.status,'pending');assert.equal((await api(env,'/api/works')).body.works.length,0);
  assert.equal(result.body.work.withdrawnNote,null);
  assert.equal((await api(env,'/api/admin/works','admin')).body.works.length,1);
  await env.store.review(work.id,{decision:'approve',expectedRevision:result.body.work.revision});assert.equal((await api(env,'/api/works')).body.works.length,1);
});

test('无归属历史作品公开时保留管理，下架后不能被任意账号操作；草稿不能下架',async t=>{
  const env=await setup(t),legacy=await seed(env,{unowned:true});
  const result=await api(env,'/api/works/'+legacy.id+'/withdraw','creator','POST',{revision:legacy.revision});assert.equal(result.status,200);
  assert.equal((await api(env,'/api/user/works','other')).body.works.length,0);
  for(const actor of ['admin','creator','other']){
    assert.equal((await edit(env,result.body.work,actor,'withdrawn')).status,403);
    assert.equal((await api(env,'/api/works/'+legacy.id,actor,'DELETE',{revision:result.body.work.revision})).status,403);
  }
  assert.equal((await fetch(env.url()+legacy.media[0].url)).status,404);
  assert.equal((await fetch(env.url()+legacy.media[0].url,{headers:{cookie:env.users.other.cookie}})).status,200);
  const draft=await seed(env,{intent:'draft'});
  assert.equal((await api(env,'/api/works/'+draft.id+'/withdraw','creator','POST',{revision:draft.revision})).status,409);
  assert.equal((await edit(env,draft,'creator','withdrawn')).status,409);
});
