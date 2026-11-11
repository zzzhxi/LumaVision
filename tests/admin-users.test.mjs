import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

const parent=resolve('test-results');
await mkdir(parent,{recursive:true});
const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
const CAPTCHA='ABC234',PASSWORD='Pass1234';
const email=label=>`${label}-${randomUUID().slice(0,8)}@test.dev`;

async function setup(t){
  const dir=await mkdtemp(join(parent,'admin-users-test-'));
  const codes=new Map();
  const options={storageRoot:dir,sendAuthCode:async({email,code,purpose})=>{codes.set(email,code);codes.set(`${purpose}:${email}`,code);return {delivery:'email'};},captchaFactory:()=>({text:CAPTCHA,image:Buffer.from('captcha')}),registrationEmailDomains:null};
  const app=await createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const url=()=>`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(done=>app.server.close(done));const target=resolve(dir);assert.ok(target.startsWith(parent+sep)&&target.includes('admin-users-test-'));await rm(target,{recursive:true,force:true});});
  return {url,dir,codes,captcha:CAPTCHA,app};
}
async function api(env,path,{method='GET',cookie,body}={}){
  const response=await fetch(env.url()+path,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json().catch(()=>({})),headers:response.headers};
}
async function register(env,email,password=PASSWORD){
  const challenge=await api(env,'/api/auth/code',{method:'POST',body:{email}});
  assert.equal(challenge.status,200,JSON.stringify(challenge.body));
  const captcha=await api(env,'/api/auth/captcha');
  assert.equal(captcha.status,200);
  const response=await api(env,'/api/auth/register',{method:'POST',body:{email,code:env.codes.get(`register:${email.toLowerCase()}`),challengeId:challenge.body.challengeId,password,captchaId:captcha.body.challengeId,captcha:env.captcha}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  return {response,user:response.body.user,cookie:response.headers.get('set-cookie').split(';')[0]};
}
async function login(env,email,password=PASSWORD){
  const response=await api(env,'/api/auth/login',{method:'POST',body:{email,password}});
  return {response,cookie:response.status===200?response.headers.get('set-cookie').split(';')[0]:null};
}
async function uploadWork(env,cookie,overrides={}){
  const metadata={id:`work-${randomUUID()}`,requestId:randomUUID(),revision:0,title:'账号管理测试作品',prompt:'A quiet scene, soft light.',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[{file:0}],...overrides};
  const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.append('files',new File([picture],'a.jpg',{type:'image/jpeg'}));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie},body:form});
  return {status:response.status,body:await response.json()};
}

test('账号列表支持搜索筛选分页，且不返回密码或会话字段',async t=>{
  const env=await setup(t);
  const adminEmail=email('admin'),alphaEmail=email('alpha'),betaEmail=email('beta');
  const admin=await register(env,adminEmail);
  assert.equal(admin.user.role,'admin');
  const alpha=await register(env,alphaEmail);
  const beta=await register(env,betaEmail);
  assert.equal(alpha.user.role,'user');
  assert.equal(beta.user.role,'user');
  await env.app.auth.updateProfile(alpha.user.id,{nickname:'alpha'});
  await env.app.auth.updateProfile(beta.user.id,{nickname:'beta'});
  await env.app.auth.upsertImportedAuthor('legacy_author','迁移作者');

  const denied=await api(env,'/api/admin/users');
  assert.equal(denied.status,401);
  const forbidden=await api(env,'/api/admin/users',{cookie:alpha.cookie});
  assert.equal(forbidden.status,403);

  const page=await api(env,'/api/admin/users?limit=2&page=1',{cookie:admin.cookie});
  assert.equal(page.status,200);
  assert.equal(page.body.total,4);
  assert.equal(page.body.pages,2);
  assert.equal(page.body.users.length,2);
  assert.equal(page.body.counts.admins,1);
  assert.equal(page.body.counts.total,4);
  assert.ok(page.body.users.every(user=>!('passwordHash' in user)&&!('googleId' in user)&&!('sessions' in user)));
  assert.ok(page.body.users.every(user=>user.works&&typeof user.works.total==='number'));
  assert.ok(page.body.users.some(user=>user.lastLoginAt));

  const search=await api(env,'/api/admin/users?q=alpha',{cookie:admin.cookie});
  assert.equal(search.status,200);
  assert.deepEqual(search.body.users.map(user=>user.email),[alphaEmail]);
  const admins=await api(env,'/api/admin/users?role=admin',{cookie:admin.cookie});
  assert.equal(admins.body.total,1);
  const imported=await api(env,'/api/admin/users?kind=imported',{cookie:admin.cookie});
  assert.equal(imported.body.total,1);
  assert.equal(imported.body.users[0].importedAuthor,true);
  const loginAccounts=await api(env,'/api/admin/users?kind=login',{cookie:admin.cookie});
  assert.equal(loginAccounts.body.total,3);
});

test('角色调整保护自身，并支持停用、启用与会话失效',async t=>{
  const env=await setup(t);
  const adminEmail=email('admin'),userEmail=email('user');
  const admin=await register(env,adminEmail);
  const user=await register(env,userEmail);
  const second=await login(env,userEmail);
  assert.equal(second.response.status,200);

  const selfRole=await api(env,`/api/admin/users/${admin.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{role:'user'}});
  assert.equal(selfRole.status,403);
  const promote=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{role:'admin'}});
  assert.equal(promote.status,200);
  assert.equal(promote.body.user.role,'admin');
  const demote=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{role:'user'}});
  assert.equal(demote.status,200);
  assert.equal(demote.body.user.role,'user');

  const disabled=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:true,disabledReason:'测试停用'}});
  assert.equal(disabled.status,200);
  assert.equal((await api(env,'/api/user/works',{cookie:user.cookie})).status,401);
  assert.equal((await api(env,'/api/user/works',{cookie:second.cookie})).status,401);
  assert.equal((await login(env,userEmail)).response.status,403);
  const listed=await api(env,'/api/admin/users?status=disabled',{cookie:admin.cookie});
  assert.equal(listed.body.total,1);
  assert.equal(listed.body.users[0].disabledReason,'测试停用');

  const enabled=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:false}});
  assert.equal(enabled.status,200);
  assert.equal((await api(env,'/api/user/works',{cookie:user.cookie})).status,401);
  const fresh=await login(env,userEmail);
  assert.equal(fresh.response.status,200);
  assert.equal((await api(env,'/api/user/works',{cookie:fresh.cookie})).status,200);
});

test('两个管理员并发互相降权时至少保留一个有效管理员',async t=>{
  const env=await setup(t);
  const first=await register(env,email('first'));
  const second=await register(env,email('second'));
  assert.equal((await api(env,`/api/admin/users/${second.user.id}`,{method:'PATCH',cookie:first.cookie,body:{role:'admin'}})).status,200);
  const results=await Promise.all([
    api(env,`/api/admin/users/${second.user.id}`,{method:'PATCH',cookie:first.cookie,body:{role:'user'}}),
    api(env,`/api/admin/users/${first.user.id}`,{method:'PATCH',cookie:second.cookie,body:{role:'user'}})
  ]);
  assert.equal(results.filter(result=>result.status===200).length,1);
  assert.equal(results.filter(result=>result.status===403||result.status===409).length,1);
  const admins=await env.app.auth.listUsersForAdmin({role:'admin',status:'active'});
  assert.equal(admins.total,1);
});

test('创作者申请在账号停用时暂停，启用后恢复且可直接调整状态',async t=>{
  const env=await setup(t);
  const admin=await register(env,email('admin'));
  const userEmail=email('creator');
  const user=await register(env,userEmail);
  await env.app.auth.requestCreator(user.user.id,{social:{x:'https://x.com/creator'}});
  assert.equal((await api(env,'/api/admin/creators?status=pending',{cookie:admin.cookie})).body.users.length,1);
  assert.equal((await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:true}})).status,200);
  assert.equal((await api(env,'/api/admin/creators?status=pending',{cookie:admin.cookie})).body.users.length,0);
  assert.equal((await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:false}})).status,200);
  assert.equal((await api(env,'/api/admin/creators?status=pending',{cookie:admin.cookie})).body.users.length,1);

  const approved=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{creatorStatus:'approved'}});
  assert.equal(approved.status,200);
  assert.equal(approved.body.user.creatorStatus,'approved');
  const fresh=await login(env,userEmail);
  assert.equal(fresh.response.status,200);
  assert.equal((await api(env,'/api/auth/me',{cookie:fresh.cookie})).body.user.creatorStatus,'approved');
  const rejected=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{creatorStatus:'rejected',creatorNote:'资料不完整'}});
  assert.equal(rejected.status,200);
  assert.equal(rejected.body.user.creatorStatus,'rejected');
  assert.equal(rejected.body.user.creatorNote,'资料不完整');
  assert.equal(rejected.body.user.accountType,'personal');
  const revised=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{creatorStatus:'rejected',creatorNote:'更新后的原因'}});
  assert.equal(revised.status,200);
  assert.equal(revised.body.user.creatorNote,'更新后的原因');
  assert.equal((await api(env,'/api/admin/users?creatorStatus=rejected',{cookie:admin.cookie})).body.total,1);
});

test('停用会失效已发出的重置验证码',async t=>{
  const env=await setup(t);
  const admin=await register(env,email('admin'));
  const userEmail=email('reset');
  const user=await register(env,userEmail);
  const challenge=await env.app.auth.requestCode(userEmail,{purpose:'reset',requireExisting:true});
  assert.ok(env.codes.get(`reset:${userEmail}`));
  const disabled=await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:true}});
  assert.equal(disabled.status,200);
  assert.equal((await api(env,`/api/admin/users/${user.user.id}`,{method:'PATCH',cookie:admin.cookie,body:{disabled:false}})).status,200);
  await assert.rejects(()=>env.app.auth.resetPassword({email:userEmail,code:env.codes.get(`reset:${userEmail}`),challengeId:challenge.challengeId,password:'Newpass123'}),{status:401});
});

test('注销会匿名化账号、保留作品和媒体、释放邮箱并失效旧会话',async t=>{
  const env=await setup(t);
  const admin=await register(env,email('admin')),authorEmail=email('author');
  const author=await register(env,authorEmail);
  await env.app.auth.requestCreator(author.user.id,{social:{x:'https://x.com/author'}});
  await env.app.auth.reviewCreator(author.user.id,{decision:'approve'});
  const uploaded=await uploadWork(env,author.cookie);
  assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
  const work=await env.app.store.get(uploaded.body.work.id);
  await env.app.store.review(work.id,{decision:'approve',expectedRevision:work.revision});

  const denied=await api(env,`/api/admin/users/${author.user.id}`,{method:'DELETE',cookie:admin.cookie,body:{confirmEmail:email('wrong')}});
  assert.equal(denied.status,400);
  const deleted=await api(env,`/api/admin/users/${author.user.id}`,{method:'DELETE',cookie:admin.cookie,body:{confirmEmail:authorEmail}});
  assert.equal(deleted.status,200,JSON.stringify(deleted.body));
  assert.equal(deleted.body.user.nickname,'已注销用户');
  assert.equal(deleted.body.user.deletedAt>0,true);
  assert.equal(deleted.body.user.hasPassword,false);
  assert.equal((await api(env,'/api/user/works',{cookie:author.cookie})).status,401);
  assert.equal((await login(env,authorEmail)).response.status,401);

  const all=await api(env,'/api/admin/users',{cookie:admin.cookie});
  assert.equal(all.body.users.some(user=>user.id===author.user.id),false);
  const removed=await api(env,'/api/admin/users?status=deleted',{cookie:admin.cookie});
  assert.equal(removed.body.total,1);
  assert.ok(removed.body.users[0].email.startsWith('deleted-'));

  const publicWorks=await api(env,'/api/works');
  const publicWork=publicWorks.body.works.find(item=>item.id===work.id);
  assert.equal(publicWork.author,'已注销用户');
  assert.equal(publicWork.authorProfile.nickname,'已注销用户');
  assert.equal(publicWork.authorProfile.deleted,true);
  const authorPage=await api(env,`/api/users/${author.user.id}/works`);
  assert.equal(authorPage.status,200);
  assert.equal(authorPage.body.user.nickname,'已注销用户');
  assert.equal(authorPage.body.works.length,1);
  assert.equal((await fetch(env.url()+publicWork.media[0].url)).status,200);

  const again=await register(env,authorEmail,'Newpass123');
  assert.notEqual(again.user.id,author.user.id);
  assert.notEqual(again.user.nickname,'已注销用户');
  assert.equal((await login(env,authorEmail)).response.status,401);
  assert.equal((await login(env,authorEmail,'Newpass123')).response.status,200);
});

test('管理员可以清理已注销作者的下架作品',async t=>{
  const env=await setup(t);
  const admin=await register(env,email('admin')),authorEmail=email('author');
  const author=await register(env,authorEmail);
  await env.app.auth.requestCreator(author.user.id,{social:{x:'https://x.com/author'}});
  await env.app.auth.reviewCreator(author.user.id,{decision:'approve'});
  const uploaded=await uploadWork(env,author.cookie);
  assert.equal(uploaded.status,200);
  const work=await env.app.store.get(uploaded.body.work.id);
  await env.app.store.review(work.id,{decision:'approve',expectedRevision:work.revision});
  const approved=await env.app.store.get(work.id);
  const withdrawn=await api(env,`/api/works/${work.id}/withdraw`,{method:'POST',cookie:author.cookie,body:{revision:approved.revision}});
  assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.body));
  const liveAuthorWork=await env.app.store.get(work.id);
  assert.equal((await api(env,`/api/works/${work.id}`,{method:'DELETE',cookie:admin.cookie,body:{revision:liveAuthorWork.revision}})).status,403);
  assert.equal((await api(env,`/api/admin/users/${author.user.id}`,{method:'DELETE',cookie:admin.cookie,body:{confirmEmail:authorEmail}})).status,200);
  const current=await env.app.store.get(work.id);
  const cleanup=await api(env,`/api/works/${work.id}`,{method:'DELETE',cookie:admin.cookie,body:{revision:current.revision}});
  assert.equal(cleanup.status,200,JSON.stringify(cleanup.body));
  assert.ok((await env.app.store.get(work.id)).deletedAt);
});

test('导入作者和 ADMIN_EMAILS 账号在后台受保护',async t=>{
  const managedEmail=email('managed');
  process.env.ADMIN_EMAILS=managedEmail;
  t.after(()=>{delete process.env.ADMIN_EMAILS;});
  const env=await setup(t);
  const managed=await register(env,managedEmail);
  assert.equal(managed.user.role,'admin');
  const other=await register(env,email('other'));
  const imported=await env.app.auth.upsertImportedAuthor('legacy','导入作者');

  const list=await api(env,'/api/admin/users?kind=all',{cookie:managed.cookie});
  assert.equal(list.status,200);
  assert.equal(list.body.users.find(user=>user.id===managed.user.id).envManaged,true);

  assert.equal((await api(env,`/api/admin/users/${other.user.id}`,{method:'PATCH',cookie:managed.cookie,body:{role:'admin'}})).status,200);
  assert.equal((await api(env,`/api/admin/users/${managed.user.id}`,{method:'PATCH',cookie:managed.cookie,body:{creatorStatus:'approved'}})).status,200);
  assert.equal((await api(env,`/api/admin/users/${managed.user.id}`,{method:'PATCH',cookie:other.cookie,body:{role:'user'}})).status,403);
  assert.equal((await api(env,`/api/admin/users/${managed.user.id}`,{method:'PATCH',cookie:other.cookie,body:{disabled:true}})).status,403);
  assert.equal((await api(env,`/api/admin/users/${managed.user.id}`,{method:'DELETE',cookie:other.cookie,body:{confirmEmail:managedEmail}})).status,403);

  assert.equal((await api(env,`/api/admin/users/${imported.id}`,{method:'PATCH',cookie:managed.cookie,body:{role:'admin'}})).status,403);
  assert.equal((await api(env,`/api/admin/users/${imported.id}`,{method:'DELETE',cookie:managed.cookie,body:{confirmEmail:imported.email}})).status,403);
});
