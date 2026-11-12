import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { studioItems } from '../studio.js';

const parent=resolve('test-results');await mkdir(parent,{recursive:true});
const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
async function setup(t){
  const dir=await mkdtemp(join(parent,'studio-test-'));
  const options={storageRoot:dir,sendAuthCode:async()=>({delivery:'email'})};
  let app=await createApp(options);
  const listen=async()=>{app.server.listen(0,'127.0.0.1');await once(app.server,'listening');};await listen();
  t.after(async()=>{await new Promise(done=>app.server.close(done));assert.ok(dir.startsWith(parent+sep+'studio-test-'));await rm(dir,{recursive:true,force:true});});
  const users={};
  for(const name of ['admin','creator']){
    const user=await app.auth.upsertByEmail(name+'@studio.test',{nickname:name});
    await app.auth.completeOnboarding(user.id,{accountType:'creator',social:{x:'https://x.com/'+name}});
    await app.auth.reviewCreator(user.id,{decision:'approve'});
    users[name]={user,cookie:'luma_session='+(await app.auth.createSession(user.id)).token};
  }
  return {dir,users,get app(){return app;},url:()=>`http://127.0.0.1:${app.server.address().port}`,async restart(){await new Promise(done=>app.server.close(done));app=await createApp(options);await listen();}};
}
const input=()=>({title:'离线生成结果夹具',prompt:'Quiet ocean.',model:'GPT Image',category:'自然风光',ratio:'3:4',provider:'offline-fixture',providerResultId:randomUUID()});
async function result(env,actor='creator'){return env.app.generations.record(input(),[new File([picture],'result.jpg',{type:'image/jpeg'})],env.users[actor].user);}
async function post(env,record,actor='creator',overrides={}){
  const form=new FormData();form.set('metadata',JSON.stringify({id:'work-'+randomUUID(),requestId:randomUUID(),revision:0,title:record.title,prompt:record.prompt,model:record.model,category:record.category,ratio:record.ratio,type:'image',generationId:record.id,media:record.media.map(m=>({existing:m.id})),...overrides}));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie:env.users[actor].cookie},body:form});return {status:response.status,body:await response.json()};
}

test('创作台分类只收录本人真实生成记录与已公开图片投稿，不混入手动上传、草稿、未审核或他人作品',()=>{
  const generation={id:'generation-1',authorId:'user-1',generated:true,status:'succeeded',type:'image',media:[{id:'output'}]};
  const work={id:'published',authorId:'user-1',uploaded:true,status:'published',type:'image',generationId:generation.id,generationMediaIds:['copy'],media:[{id:'copy'}]};
  const props={drafts:[{id:'draft'}],generations:[generation,{...generation,id:'other-result',authorId:'user-2'}],works:[work,{...work,id:'manual',generationId:null},{...work,id:'pending',status:'pending'},{...work,id:'rejected',status:'rejected'},{...work,id:'withdrawn',status:'withdrawn'},{...work,id:'other',authorId:'user-2'},{...work,id:'no-output',generationMediaIds:[],media:[{id:'manual'}]},{...work,id:'video',type:'video'}],userId:'user-1'};
  assert.deepEqual(studioItems({...props,tab:'drafts'}).map(p=>p.id),['draft']);
  assert.deepEqual(studioItems({...props,tab:'generations'}).map(p=>p.id),['generation-1']);
  assert.deepEqual(studioItems({...props,tab:'submissions'}).map(p=>p.id),['published']);
  const card={...work,id:'card',cardOnly:true,generationMediaIds:['generated'],media:[{id:'manual-cover'}]};
  assert.deepEqual(studioItems({...props,tab:'submissions',works:[...props.works,card]}).map(p=>p.id),['published','card']);
  assert.deepEqual(studioItems({...props,tab:'submissions',userId:null}),[]);
});

test('生成记录与原图片保持账号私有，重启保留，拒绝无实际图片结果与伪造的HTTP生成接口',async t=>{
  const env=await setup(t),record=await result(env);
  const list=actor=>fetch(env.url()+'/api/user/generations',{headers:actor?{cookie:env.users[actor].cookie}:{}});
  assert.equal((await list(null)).status,401);
  assert.equal((await (await list('admin')).json()).generations.length,0);
  assert.equal((await (await list('creator')).json()).generations.length,1);
  assert.equal((await fetch(env.url()+record.media[0].url)).status,404);
  assert.equal((await fetch(env.url()+record.media[0].url,{headers:{cookie:env.users.admin.cookie}})).status,404);
  const image=await fetch(env.url()+record.media[0].url,{headers:{cookie:env.users.creator.cookie,Range:'bytes=0-19'}});
  assert.equal(image.status,206);assert.deepEqual(Buffer.from(await image.arrayBuffer()),picture.subarray(0,20));
  await assert.rejects(()=>env.app.generations.record(input(),[],env.users.creator.user),error=>error.status===400);
  await env.restart();assert.equal((await (await list('creator')).json()).generations[0].id,record.id);
  assert.equal((await fetch(env.url()+'/api/user/generations',{method:'POST',headers:{cookie:env.users.creator.cookie}})).status,405);
});

test('投稿验证本人生成来源并复制图片；审核通过才收录，来源跨编辑保留、移除生成图片后不再算投稿',async t=>{
  const env=await setup(t),record=await result(env);
  assert.equal((await post(env,record,'admin')).status,403);
  assert.equal((await post(env,record,'creator',{media:[]})).status,400);
  const posted=await post(env,record);assert.equal(posted.status,200);
  const work=posted.body.work;
  assert.equal(work.status,'pending');assert.equal(work.generationId,record.id);
  assert.notEqual(work.media[0].id,record.media[0].id);
  assert.deepEqual(await readFile(join(env.dir,'media',work.media[0].id)),picture);
  assert.deepEqual(studioItems({tab:'submissions',drafts:[],generations:[record],works:[work],userId:work.authorId}),[]);
  const published=await env.app.store.review(work.id,{decision:'approve',expectedRevision:work.revision});
  assert.equal(studioItems({tab:'submissions',drafts:[],generations:[record],works:[published],userId:work.authorId}).length,1);
  const cookie={cookie:env.users.creator.cookie};
  const cards=(await (await fetch(env.url()+'/api/user/works?limit=100&cards=1&sort=updated',{headers:cookie})).json()).works;
  const records=(await (await fetch(env.url()+'/api/user/generations',{headers:cookie})).json()).generations;
  assert.equal(cards.length,1);
  assert.deepEqual(cards[0].generationMediaIds,work.generationMediaIds);
  assert.equal(studioItems({tab:'submissions',drafts:[],generations:records,works:cards,userId:work.authorId}).length,1);
  assert.equal((await fetch(env.url()+record.media[0].url)).status,404);
  const metadata={id:work.id,requestId:randomUUID(),revision:published.revision,title:'保留来源',prompt:work.prompt,model:work.model,category:work.category,ratio:work.ratio,type:'image',media:work.media.map(m=>({existing:m.id}))};
  const updated=await env.app.store.save(metadata,[],env.users.creator.user);assert.equal(updated.generationId,record.id);
  const cleared=await env.app.store.save({...metadata,requestId:randomUUID(),revision:updated.revision,media:[]},[],env.users.creator.user);assert.equal(cleared.generationId,null);
  const form=new FormData();
  form.set('metadata',JSON.stringify({...metadata,id:'work-'+randomUUID(),requestId:randomUUID(),revision:0,generationId:null,generated:true,generationMediaIds:[record.media[0].id],media:[{file:0}]}));
  form.append('files',new File([picture],'manual.jpg',{type:'image/jpeg'}));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie:env.users.creator.cookie},body:form});
  assert.equal(response.status,200);
  const manual=(await response.json()).work;assert.equal(manual.generationId,null);assert.deepEqual(manual.generationMediaIds,[]);
  const manualPublished=await env.app.store.review(manual.id,{decision:'approve',expectedRevision:manual.revision});
  assert.deepEqual(studioItems({tab:'submissions',drafts:[],generations:[record],works:[manualPublished],userId:manual.authorId}),[]);
});

test('生成记录仅作者本人可永久删除，删除后图片与记录不可再访问，已投稿的记录需先移除作品',async t=>{
  const env=await setup(t),record=await result(env);
  const remove=(id,actor)=>fetch(env.url()+'/api/generations/'+id,{method:'DELETE',headers:actor?{cookie:env.users[actor].cookie}:{}});
  assert.equal((await remove(record.id)).status,401);
  assert.equal((await remove(record.id,'admin')).status,404);
  const posted=await post(env,record);assert.equal(posted.status,200);
  assert.equal((await remove(record.id,'creator')).status,409);
  const work=posted.body.work;
  await env.app.store.setDeleted(work.id,true,work.revision,env.users.creator.user.id);
  const response=await remove(record.id,'creator');assert.equal(response.status,200);
  assert.equal((await response.json()).deleted,record.id);
  assert.equal((await fetch(env.url()+record.media[0].url,{headers:{cookie:env.users.creator.cookie}})).status,404);
  const remaining=await (await fetch(env.url()+'/api/user/generations',{headers:{cookie:env.users.creator.cookie}})).json();
  assert.deepEqual(remaining.generations,[]);
  await assert.rejects(readFile(join(env.dir,'generations',record.id+'.json')),error=>error.code==='ENOENT');
  await assert.rejects(readFile(join(env.dir,'generated-media',record.media[0].id)),error=>error.code==='ENOENT');
  assert.equal((await remove(record.id,'creator')).status,404);
});
