import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { renderCaptcha, CAPTCHA_ALPHABET } from '../captcha.mjs';
import { REGISTRATION_EMAIL_DOMAINS } from '../email-domains.js';
import { proxyRequest } from './proxy-request.mjs';

const parent=resolve('test-results');
await mkdir(parent,{recursive:true});
const picture=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
const CAPTCHA='ABC234',PASSWORD='Pass1234';

async function setup(t,registrationEmailDomains=null,appOptions={}){
  const dir=await mkdtemp(join(parent,'account-test-'));
  const codes=new Map();
  const options={storageRoot:dir,sendAuthCode:async({email,code,purpose})=>{codes.set(email,code);codes.set(`${purpose}:${email}`,code);return {delivery:'email'};},captchaFactory:()=>({text:CAPTCHA,image:Buffer.from('captcha')}),registrationEmailDomains,...appOptions};
  let app=await createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const url=()=>`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));const target=resolve(dir);assert.ok(target.startsWith(parent+sep)&&target.includes('account-test-'));await rm(target,{recursive:true,force:true});});
  const headers=options.publicOrigin?{Host:new URL(options.publicOrigin).host,Origin:options.publicOrigin}:{};
  return {url,dir,codes,headers,captcha:CAPTCHA,get auth(){return app.auth;},async restart(){await new Promise(resolve=>app.server.close(resolve));app=await createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');}};
}
async function json(env,path,options={}){
  if(/^\/api\/admin\/works\/work-[0-9a-f-]{36}\/review$/.test(path)&&options.body?.expectedRevision===undefined){
    const id=path.split('/')[4],work=JSON.parse(await readFile(join(env.dir,'works',id+'.json'),'utf8'));
    options={...options,body:{...options.body,expectedRevision:work.revision}};
  }
  const request=env.headers.Host?proxyRequest:fetch;
  const response=await request(env.url()+path,{method:options.method||'GET',headers:{'Content-Type':'application/json',...env.headers,...options.headers},body:options.body?JSON.stringify(options.body):undefined,redirect:'manual'});
  return {status:response.status,body:await response.json().catch(()=>({})),headers:response.headers};
}
async function register(env,email,password=PASSWORD){
  const challenge=await json(env,'/api/auth/code',{method:'POST',body:{email}});
  assert.equal(challenge.status,200);
  const captcha=await json(env,'/api/auth/captcha');
  assert.equal(captcha.status,200);
  return json(env,'/api/auth/register',{method:'POST',body:{email,code:env.codes.get(`register:${email.toLowerCase()}`),challengeId:challenge.body.challengeId,password,captchaId:captcha.body.challengeId,captcha:env.captcha}});
}
async function authenticate(env,email,password=PASSWORD){
  let response=await json(env,'/api/auth/login',{method:'POST',body:{email,password}});
  if(response.status===401)response=await register(env,email,password);
  return response;
}
async function login(env,email,password=PASSWORD){
  let response=await authenticate(env,email,password);
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  if(!response.body.user.onboardingComplete){
    response=await json(env,'/api/user/onboarding',{method:'PATCH',body:{accountType:'personal'},headers:{cookie}});
    assert.equal(response.status,200);
  }
  return {cookie,user:response.body.user};
}
function metadata(overrides={}){return {id:`work-${randomUUID()}`,requestId:randomUUID(),revision:0,title:'审核流程测试',prompt:'A quiet scene, soft light.',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[{file:0}],...overrides};}
async function uploadWork(env,cookie,overrides={}){
  const form=new FormData();form.set('metadata',JSON.stringify(metadata(overrides)));
  form.append('files',new File([picture],'a.jpg',{type:'image/jpeg'}));
  const response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie},body:form});
  return {status:response.status,body:await response.json()};
}

test('公网模式按 HTTPS 来源校验请求、保护会话并只授予名单账号管理员权限',async t=>{
  const publicOrigin='https://gallery.example.com',adminEmail='admin-prod@example.com',previous=process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS=adminEmail;
  t.after(()=>{if(previous===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=previous;});
  const env=await setup(t,undefined,{publicOrigin});
  assert.equal((await json(env,'/api/auth/me')).status,200);
  assert.equal((await json(env,'/api/auth/me',{headers:{Host:'localhost:5173','X-Forwarded-Host':'gallery.example.com'}})).status,403);
  for(const origin of ['http://gallery.example.com','https://other.example.com','null']){
    assert.equal((await json(env,'/api/auth/logout',{method:'POST',headers:{Origin:origin,'X-Forwarded-Proto':'https'}})).status,403);
  }
  const first=await register(env,'first-prod@example.com');
  assert.equal(first.status,200);
  assert.equal(first.body.user.role,'user');
  const cookie=first.headers.get('set-cookie');
  assert.match(cookie,/; Secure(?:;|$)/);
  assert.equal((await json(env,'/api/admin/users',{headers:{cookie:cookie.split(';')[0]}})).status,403);
  const admin=await register(env,adminEmail);
  assert.equal(admin.status,200);
  assert.equal(admin.body.user.role,'admin');
  const adminCookie=admin.headers.get('set-cookie').split(';')[0];
  assert.equal((await json(env,'/api/admin/users',{headers:{cookie:adminCookie}})).status,200);
  const logout=await json(env,'/api/auth/logout',{method:'POST',headers:{cookie:adminCookie}});
  assert.equal(logout.status,200);
  assert.match(logout.headers.get('set-cookie'),/Max-Age=0; Secure/);
});

test('图形验证码字符表全部可绘制并输出 PNG',()=>{
  const png=renderCaptcha(CAPTCHA_ALPHABET);
  assert.deepEqual([...png.subarray(0,8)],[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  assert.ok(png.length>1000);
  assert.equal(new Set(CAPTCHA_ALPHABET).size,CAPTCHA_ALPHABET.length);
  for(const ambiguous of ['0','1','I','O'])assert.equal(CAPTCHA_ALPHABET.includes(ambiguous),false);
});

test('注册仅接受六个常见邮箱域名，旧账号登录和重置不受影响',async t=>{
  const domains=REGISTRATION_EMAIL_DOMAINS.map(item=>item.value),env=await setup(t,domains);
  const blocked='blocked@test.dev';
  let response=await json(env,'/api/auth/code',{method:'POST',body:{email:blocked}});
  assert.equal(response.status,400);
  assert.match(response.body.error,/注册仅支持/);
  assert.equal(env.codes.has(`register:${blocked}`),false);

  for(const domain of domains){
    const result=await register(env,`allowed-${domain.replace(/\./g,'-')}@${domain}`);
    assert.equal(result.status,200,`${domain}: ${JSON.stringify(result.body)}`);
  }

  const bypassEmail=`bypass-${randomUUID().slice(0,8)}@qq.com`,rejectedEmail=`bypass-${randomUUID().slice(0,8)}@test.dev`;
  const challenge=await json(env,'/api/auth/code',{method:'POST',body:{email:bypassEmail}});
  assert.equal(challenge.status,200);
  const captcha=await json(env,'/api/auth/captcha');
  const body={email:rejectedEmail,code:env.codes.get(`register:${bypassEmail}`),challengeId:challenge.body.challengeId,password:PASSWORD,captchaId:captcha.body.challengeId,captcha:env.captcha};
  response=await json(env,'/api/auth/register',{method:'POST',body});
  assert.equal(response.status,400);
  body.email=bypassEmail;
  response=await json(env,'/api/auth/register',{method:'POST',body});
  assert.equal(response.status,200);

  const legacyEmail=`legacy-${randomUUID().slice(0,8)}@test.dev`;
  await env.auth.upsertByEmail(legacyEmail);
  const reset=await json(env,'/api/auth/password/reset/code',{method:'POST',body:{email:legacyEmail}});
  assert.equal(reset.status,200);
  response=await json(env,'/api/auth/password/reset',{method:'POST',body:{email:legacyEmail,code:env.codes.get(`reset:${legacyEmail}`),challengeId:reset.body.challengeId,password:'Newpass123'}});
  assert.equal(response.status,200);
  response=await json(env,'/api/auth/login',{method:'POST',body:{email:legacyEmail,password:'Newpass123'}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.email,legacyEmail);
});

test('作品作者资料使用最新公开社交主页，不泄露申请材料或账号隐私，不写入作品存储',async t=>{
  const env=await setup(t);
  const {cookie,user}=await login(env,'social@test.dev');
  await env.auth.requestCreator(user.id,{social:{x:'https://x.com/creator_handle'}});
  const uploaded=await uploadWork(env,cookie);
  assert.equal(uploaded.status,200);
  assert.deepEqual(uploaded.body.work.authorProfile.social,{});
  const id=uploaded.body.work.id;
  await json(env,`/api/admin/works/${id}/review`,{method:'POST',headers:{cookie},body:{decision:'approve'}});
  const work=async()=> (await json(env,'/api/works')).body.works.find(item=>item.id===id);
  assert.deepEqual((await work()).authorProfile.social,{});
  await env.auth.reviewCreator(user.id,{decision:'approve'});
  const profile=(await work()).authorProfile;
  assert.equal(profile.social.x,'https://x.com/creator_handle');
  for(const key of ['email','role','creatorStatus','creatorNote','passwordHash'])assert.equal(profile[key],undefined);
  await env.auth.updateProfile(user.id,{nickname:'新的昵称',social:{instagram:'https://instagram.com/new_handle'}});
  const updated=(await work()).authorProfile;
  assert.equal(updated.nickname,'新的昵称');
  assert.deepEqual(updated.social,{instagram:'https://instagram.com/new_handle'});
  assert.deepEqual((await json(env,'/api/user/works',{headers:{cookie}})).body.works[0].authorProfile,updated);
  assert.deepEqual((await json(env,`/api/users/${user.id}/works`)).body.works[0].authorProfile,updated);
  const disk=JSON.parse(await readFile(join(env.dir,'works',id+'.json'),'utf8'));
  assert.equal(disk.authorProfile,undefined);
});

test('邮箱注册需验证码、密码和图形验证码；登录使用邮箱密码并持久会话',async t=>{
  const env=await setup(t);
  let response=await json(env,'/api/auth/code',{method:'POST',body:{email:'not-an-email'}});
  assert.equal(response.status,400);
  const challenge=await json(env,'/api/auth/code',{method:'POST',body:{email:'admin@test.dev'}});
  assert.equal(challenge.status,200);
  assert.equal(challenge.body.devCode,undefined);
  assert.equal(await env.auth.userByEmail('admin@test.dev'),null);
  const stored=JSON.parse(await readFile(join(env.dir,'auth/codes.json'),'utf8'));
  assert.equal(stored.codes['register:admin@test.dev'].code,undefined);
  assert.equal(stored.codes['register:admin@test.dev'].purpose,'register');
  assert.match(stored.codes['register:admin@test.dev'].hash,/^[a-f0-9]{64}$/);
  assert.equal((await json(env,'/api/auth/code',{method:'POST',body:{email:'admin@test.dev'}})).status,429);
  response=await json(env,'/api/auth/login',{method:'POST',body:{email:'admin@test.dev',password:PASSWORD}});
  assert.equal(response.status,401);
  const captcha=await json(env,'/api/auth/captcha');
  assert.equal(captcha.status,200);
  assert.match(captcha.body.image,/^data:image\/png;base64,/);
  assert.equal(captcha.body.text,undefined);
  const body={email:'admin@test.dev',code:env.codes.get('register:admin@test.dev'),challengeId:challenge.body.challengeId,password:PASSWORD,captchaId:captcha.body.challengeId,captcha:'WRONG1'};
  response=await json(env,'/api/auth/register',{method:'POST',body});
  assert.equal(response.status,401);
  assert.equal(await env.auth.userByEmail('admin@test.dev'),null);
  const replacement=await json(env,'/api/auth/captcha');
  body.captchaId=replacement.body.challengeId;
  body.captcha=env.captcha;
  response=await json(env,'/api/auth/register',{method:'POST',body});
  assert.equal(response.status,200);
  assert.equal(response.body.user.role,'admin');
  assert.equal(response.body.user.accountType,'personal');
  assert.equal(response.body.user.onboardingComplete,false);
  assert.equal(response.body.user.passwordHash,undefined);
  assert.equal(response.body.user.hasPassword,true);
  assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email:body.email,code:body.code,challengeId:body.challengeId}})).status,401);
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email:body.email,password:'Wrong123'}})).status,401);
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email:body.email,password:PASSWORD}})).status,200);
  assert.equal((await json(env,'/api/auth/code',{method:'POST',body:{email:body.email}})).status,409);
  response=await json(env,'/api/user/onboarding',{method:'PATCH',body:{accountType:'personal'},headers:{cookie}});
  assert.equal(response.status,200);
  await env.restart();
  response=await json(env,'/api/auth/me',{headers:{cookie}});
  assert.equal(response.body.user.accountType,'personal');
  assert.equal(response.body.user.onboardingComplete,true);
  response=await json(env,'/api/auth/login',{method:'POST',body:{email:body.email,password:PASSWORD}});
  assert.equal(response.status,200);
  assert.equal((await json(env,'/api/user/onboarding',{method:'PATCH',body:{accountType:'creator',social:{x:'https://x.com/admin'}},headers:{cookie}})).status,409);
  await json(env,'/api/auth/logout',{method:'POST',headers:{cookie}});
  assert.equal((await json(env,'/api/auth/me',{headers:{cookie}})).body.user,null);
});

test('验证码校验：错误次数、邮箱绑定、过期、重发替换和并发防重放',async t=>{
  const env=await setup(t),now=Date.now();
  const email='attempts@test.dev',challenge=await env.auth.requestCode(email,{purpose:'register',requireNew:true},now);
  const code=env.codes.get(`register:${email}`),wrong=code==='000000'?'111111':'000000';
  for(let i=0;i<5;i++){
    const captcha=await env.auth.createCaptcha(now+100+i);
    await assert.rejects(env.auth.register({email,code:wrong,challengeId:challenge.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:now+100+i}),{status:401});
  }
  let captcha=await env.auth.createCaptcha(now+200);
  await assert.rejects(env.auth.register({email,code,challengeId:challenge.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:now+200}),{status:429});
  await env.restart();
  captcha=await env.auth.createCaptcha(now+300);
  await assert.rejects(env.auth.register({email,code,challengeId:challenge.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:now+300}),{status:429});
  const replacement=await env.auth.requestCode(email,{purpose:'register',requireNew:true},now+60001);
  const replacementCode=env.codes.get(`register:${email}`);
  captcha=await env.auth.createCaptcha(now+60002);
  await assert.rejects(env.auth.register({email,code,challengeId:challenge.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:now+60002}),{status:401});
  captcha=await env.auth.createCaptcha(now+60002);
  await assert.rejects(env.auth.register({email:'other@test.dev',code:replacementCode,challengeId:replacement.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:now+60002}),{status:401});
  captcha=await env.auth.createCaptcha(now+60002);
  await assert.rejects(env.auth.register({email,code:replacementCode,challengeId:replacement.challengeId,password:PASSWORD,captchaId:captcha.challengeId,captcha:CAPTCHA,now:replacement.expiresAt}),{status:401});
  const captchas=await Promise.all([0,1].map(()=>env.auth.createCaptcha(now+60002)));
  const results=await Promise.allSettled(captchas.map(item=>env.auth.register({email,code:replacementCode,challengeId:replacement.challengeId,password:PASSWORD,captchaId:item.challengeId,captcha:CAPTCHA,now:now+60002})));
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  assert.equal(results.find(item=>item.status==='rejected').reason.status,409);
});

test('旧账号通过邮箱验证设置新密码，保留身份、资料和历史第三方账号关联',async t=>{
  const env=await setup(t);
  await login(env,'admin@test.dev');
  const file=join(env.dir,'auth/users.json'),data=JSON.parse(await readFile(file,'utf8'));
  const id=`user-${randomUUID()}`;
  data.users[id]={id,email:'legacy@test.dev',nickname:'原有创作者',role:'user',creatorStatus:'approved',social:{x:'https://x.com/legacy'},passwordHash:'legacy-unused-hash',createdAt:123};
  await writeFile(file,JSON.stringify(data));
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email:'legacy@test.dev',password:PASSWORD}})).status,401);
  const challenge=await json(env,'/api/auth/password/reset/code',{method:'POST',body:{email:'legacy@test.dev'}});
  assert.equal(challenge.status,200);
  let response=await json(env,'/api/auth/password/reset',{method:'POST',body:{email:'legacy@test.dev',code:env.codes.get('reset:legacy@test.dev'),challengeId:challenge.body.challengeId,password:'Newpass123'}});
  assert.equal(response.status,200);
  const legacy=await login(env,'legacy@test.dev','Newpass123');
  assert.equal(legacy.user.id,id);
  assert.equal(legacy.user.accountType,'creator');
  assert.equal(legacy.user.nickname,'原有创作者');
  assert.equal(legacy.user.creatorStatus,'approved');
  assert.equal(legacy.user.social.x,'https://x.com/legacy');
  assert.equal(legacy.user.passwordHash,undefined);
  assert.equal(legacy.user.hasPassword,true);
  const merged=await env.auth.upsertByEmail('LEGACY@test.dev',{googleId:'google-id',nickname:'不可覆盖'});
  assert.equal(merged.id,id);
  assert.equal(merged.nickname,'原有创作者');
  assert.equal(merged.creatorStatus,'approved');
  assert.equal(merged.googleId,'google-id');
});

test('登录用户凭邮箱验证码修改密码，旧密码失效且新密码可登录',async t=>{
  const env=await setup(t),email='bypass@test.dev',newPassword='Tqmbm582';
  const {cookie,user}=await login(env,email);
  assert.equal((await json(env,'/api/auth/password/code',{method:'POST',body:{}})).status,401);
  const challenge=await json(env,'/api/auth/password/code',{method:'POST',body:{},headers:{cookie}});
  assert.equal(challenge.status,200);
  const code=env.codes.get(`password:${email}`),wrong=code==='000000'?'111111':'000000';
  let response=await json(env,'/api/user/password',{method:'POST',body:{code:wrong,challengeId:challenge.body.challengeId,password:newPassword},headers:{cookie}});
  assert.equal(response.status,401);
  response=await json(env,'/api/user/password',{method:'POST',body:{code,challengeId:challenge.body.challengeId,password:newPassword},headers:{cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.hasPassword,true);
  assert.equal(response.body.user.email,user.email);
  assert.equal((await json(env,'/api/auth/me',{headers:{cookie}})).body.user.id,user.id);
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email,password:PASSWORD}})).status,401);
  assert.equal((await json(env,'/api/auth/login',{method:'POST',body:{email,password:newPassword}})).status,200);
});

test('创作者身份：仅审核通过的创作者可以发布作品，申请可驳回与重申',async t=>{
  const env=await setup(t);
  const admin=await login(env,'admin@test.dev');
  // 默认注册为个人用户
  const personal=await authenticate(env,'personal@test.dev');
  assert.equal(personal.status,200);
  assert.equal(personal.body.user.creatorStatus,'none');
  const personalCookie=personal.headers.get('set-cookie').split(';')[0];
  // 个人用户不能发布，也不能维护社交主页
  let denied=await uploadWork(env,personalCookie);
  assert.equal(denied.status,403);
  assert.match(denied.body.error,/创作者/);
  let response=await json(env,'/api/user/profile',{method:'PATCH',body:{social:{instagram:'https://instagram.com/p'}},headers:{cookie:personalCookie}});
  assert.equal(response.status,403);
  // 申请创作者：至少一条链接；提交后进入待审核，期间仍不能发布、不能重复申请
  response=await json(env,'/api/user/creator-application',{method:'POST',body:{social:{}},headers:{cookie:personalCookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/creator-application',{method:'POST',body:{social:{instagram:'https://instagram.com/personal'}},headers:{cookie:personalCookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.creatorStatus,'pending');
  assert.equal((await uploadWork(env,personalCookie)).status,403);
  response=await json(env,'/api/user/creator-application',{method:'POST',body:{social:{instagram:'https://instagram.com/personal'}},headers:{cookie:personalCookie}});
  assert.equal(response.status,409);
  // 只有管理员能看申请列表
  response=await json(env,'/api/admin/creators?status=pending',{headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.users.length,1);
  assert.equal(response.body.users[0].email,'personal@test.dev');
  assert.equal((await json(env,'/api/admin/creators?status=pending',{headers:{cookie:personalCookie}})).status,403);
  // 通过后可以发布（进入作品待审核），公开主页展示创作者身份与社交主页
  response=await json(env,`/api/admin/creators/${personal.body.user.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.creatorStatus,'approved');
  const work=(await uploadWork(env,personalCookie)).body.work;
  assert.equal(work.status,'pending');
  response=await json(env,`/api/users/${personal.body.user.id}/works`);
  assert.equal(response.body.user.creator,true);
  assert.equal(response.body.user.social.instagram,'https://instagram.com/personal');
  // 已处理的申请再次审核 → 409
  response=await json(env,`/api/admin/creators/${personal.body.user.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,409);
});

test('创作者注册即申请，驳回后可修改重新申请',async t=>{
  const env=await setup(t);
  const admin=await login(env,'admin@test.dev');
  const verified=await authenticate(env,'c1@test.dev');
  assert.equal(verified.status,200);
  const cookie=verified.headers.get('set-cookie').split(';')[0];
  let response=await json(env,'/api/user/onboarding',{method:'PATCH',body:{accountType:'creator'},headers:{cookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/onboarding',{method:'PATCH',body:{accountType:'creator',social:{x:'https://x.com/c1'}},headers:{cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.accountType,'creator');
  assert.equal(response.body.user.creatorStatus,'pending');
  const userId=response.body.user.id;
  // 待审核不能发布；公开主页不暴露申请中的社交链接与身份
  assert.equal((await uploadWork(env,cookie)).status,403);
  response=await json(env,`/api/users/${userId}/works`);
  assert.equal(response.body.user.creator,false);
  assert.deepEqual(response.body.user.social,{});
  // 驳回必须填写原因；驳回后本人可见原因
  response=await json(env,`/api/admin/creators/${userId}/review`,{method:'POST',body:{decision:'reject',note:''},headers:{cookie:admin.cookie}});
  assert.equal(response.status,400);
  response=await json(env,`/api/admin/creators/${userId}/review`,{method:'POST',body:{decision:'reject',note:'社交主页链接无法访问'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.creatorStatus,'rejected');
  assert.equal(response.body.user.creatorNote,'社交主页链接无法访问');
  // 重新申请后通过，即可发布
  response=await json(env,'/api/user/creator-application',{method:'POST',body:{social:{youtube:'https://youtube.com/@c1'}},headers:{cookie}});
  assert.equal(response.status,200);
  assert.equal(response.body.user.creatorStatus,'pending');
  assert.equal(response.body.user.creatorNote,null);
  assert.equal((await json(env,`/api/admin/creators/${userId}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:admin.cookie}})).status,200);
  assert.equal((await uploadWork(env,cookie)).status,200);
});

test('个人资料：昵称与社交主页校验，公开主页不暴露邮箱且只展示已通过作品',async t=>{
  const env=await setup(t);
  const {cookie,user}=await login(env,'creator@test.dev');
  // 上传测试作品需要创作者身份
  await env.auth.requestCreator(user.id,{social:{instagram:'https://instagram.com/creator'}});
  await env.auth.reviewCreator(user.id,{decision:'approve'});
  let response=await json(env,'/api/user/profile',{method:'PATCH',body:{nickname:'山与海'},headers:{cookie}});
  assert.equal(response.status,200);assert.equal(response.body.user.nickname,'山与海');
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{nickname:'  '},headers:{cookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{social:{instagram:'https://instagram.com/creator'}},headers:{cookie}});
  assert.equal(response.status,200);assert.equal(response.body.user.social.instagram,'https://instagram.com/creator');
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{social:{instagram:'http://instagram.com/creator'}},headers:{cookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{social:{instagram:'https://evil.example/creator'}},headers:{cookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{social:{bilibili:'https://bilibili.com/x'}},headers:{cookie}});
  assert.equal(response.status,400);
  response=await json(env,'/api/user/profile',{method:'PATCH',body:{nickname:'x'}});
  assert.equal(response.status,401);
  const work=(await uploadWork(env,cookie)).body.work;
  assert.equal(work.status,'pending');
  response=await json(env,`/api/users/${user.id}/works`);
  assert.equal(response.status,200);
  assert.equal(response.body.user.nickname,'山与海');
  assert.equal(response.body.user.email,undefined);
  assert.equal(response.body.user.role,undefined);
  assert.equal(response.body.works.length,0);
  // creator 是本环境首位注册用户（管理员），用TA通过作品
  assert.equal((await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie}})).status,200);
  response=await json(env,`/api/users/${user.id}/works`);
  assert.equal(response.body.works.length,1);
  const list=await json(env,'/api/works');
  assert.equal(list.body.works.length,1);
});

test('作品审核：待审核不公开、驳回原因可见、修改重新送审、权限隔离',async t=>{
  const env=await setup(t);
  const admin=await login(env,'admin@test.dev');
  const author=await login(env,'author@test.dev');
  const other=await login(env,'other@test.dev');
  // 作者需要创作者身份才能发布
  await env.auth.requestCreator(author.user.id,{social:{instagram:'https://instagram.com/author'}});
  await env.auth.reviewCreator(author.user.id,{decision:'approve'});
  const work=(await uploadWork(env,author.cookie)).body.work;
  let list=await json(env,'/api/works');
  assert.equal(list.body.works.length,0);
  let mine=await json(env,'/api/user/works',{headers:{cookie:author.cookie}});
  assert.equal(mine.body.works.length,1);
  let response=await json(env,'/api/admin/works?status=pending',{headers:{cookie:author.cookie}});
  assert.equal(response.status,403);
  response=await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:author.cookie}});
  assert.equal(response.status,403);
  response=await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'reject',note:''},headers:{cookie:admin.cookie}});
  assert.equal(response.status,400);
  response=await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'reject',note:'附件与提示词无关'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);assert.equal(response.body.work.status,'rejected');
  mine=await json(env,'/api/user/works',{headers:{cookie:author.cookie}});
  assert.equal(mine.body.works[0].status,'rejected');
  assert.equal(mine.body.works[0].reviewNote,'附件与提示词无关');
  response=await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,409);
  const form=new FormData();
  form.set('metadata',JSON.stringify({...metadata({id:work.id}),revision:mine.body.works[0].revision,media:[],title:'审核流程测试（修改）'}));
  response=await fetch(env.url()+'/api/works',{method:'POST',headers:{cookie:author.cookie},body:form}).then(async r=>({status:r.status,body:await r.json()}));
  assert.equal(response.status,200);assert.equal(response.body.work.status,'pending');
  response=await json(env,`/api/admin/works/${work.id}/review`,{method:'POST',body:{decision:'approve'},headers:{cookie:admin.cookie}});
  assert.equal(response.status,200);
  list=await json(env,'/api/works');
  assert.equal(list.body.works[0].title,'审核流程测试（修改）');
  const latest=(await json(env,'/api/user/works',{headers:{cookie:author.cookie}})).body.works[0];
  response=await fetch(env.url()+`/api/works/${work.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',cookie:other.cookie},body:JSON.stringify({revision:latest.revision})});
  assert.equal(response.status,403);
  response=await fetch(env.url()+`/api/works/${work.id}`,{method:'DELETE',headers:{'Content-Type':'application/json',cookie:admin.cookie},body:JSON.stringify({revision:latest.revision})});
  assert.equal(response.status,200);
  list=await json(env,'/api/works');
  assert.equal(list.body.works.length,0);
});

test('Google 登录入口已移除，配置凭据也不能启用',async t=>{
  const env=await setup(t);
  const oldId=process.env.GOOGLE_CLIENT_ID,oldSecret=process.env.GOOGLE_CLIENT_SECRET;
  process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';
  t.after(()=>{if(oldId===undefined)delete process.env.GOOGLE_CLIENT_ID;else process.env.GOOGLE_CLIENT_ID=oldId;if(oldSecret===undefined)delete process.env.GOOGLE_CLIENT_SECRET;else process.env.GOOGLE_CLIENT_SECRET=oldSecret;});
  for(const path of ['/api/auth/google/start','/api/auth/google/callback?code=test']){
    const response=await json(env,path);assert.equal(response.status,404);assert.equal(response.headers.get('set-cookie'),null);
  }
  const response=await json(env,'/api/auth/me');assert.equal(response.body.googleEnabled,undefined);
});

