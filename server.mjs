import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStore, HttpError, limits } from './storage.mjs';
import { createGenerationStore } from './generations.mjs';
import { createGenerationService } from './generation-service.mjs';
import { queryWorks, workCard } from './work-query.mjs';
import { readMultipart } from './multipart.mjs';
import { createDerivatives } from './derivatives.mjs';
import { emailDeliveryMode } from './email.mjs';
import { loadMailConfig } from './mail-config.mjs';
import { createAuthStore, socialLinks, SESSION_COOKIE, SESSION_TTL } from './auth.mjs';

const root=resolve(import.meta.dirname);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.png':'image/png','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm'};
const publicFiles=new Set(['/index.html','/styles.css','/uploads.css','/auth.css','/auth-ui.js','/app.js','/studio.js','/generation-ui.js','/drafts.js','/media.js','/data.js','/email-domains.js','/favicon.svg']);
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
async function body(req,max){
  if(Number(req.headers['content-length'])>max)throw new HttpError(413,'上传内容过大。');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)throw new HttpError(413,'上传内容过大。');chunks.push(chunk);}
  return Buffer.concat(chunks);
}
function sameOrigin(req){
  if(req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'请从本网站发起上传。');
  if(req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)throw new Error();}catch{throw new HttpError(403,'请从本网站发起上传。');}}
}
async function readJson(req,max=4096){
  const bytes=await body(req,max);
  try{
    const parsed=JSON.parse(bytes.toString());
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('not an object');
    return parsed;
  }catch{throw new HttpError(400,'请求格式不正确。');}
}
function cookieValue(req,name){
  const header=req.headers.cookie;if(!header)return null;
  for(const part of header.split(';')){
    const index=part.indexOf('=');if(index<0)continue;
    if(part.slice(0,index).trim()===name)return part.slice(index+1).trim();
  }
  return null;
}
const sessionCookie=(token,maxAgeSeconds)=>`${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
function serveFile(req,res,file,size,mtimeMs){
  const mime=types[extname(file)]||'application/octet-stream';
  const headers={'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':res.getHeader('Cache-Control')||'no-cache','X-Content-Type-Options':'nosniff'};
  if(mtimeMs!==undefined&&!String(headers['Cache-Control']).includes('no-store')){
    headers.ETag=`"${size.toString(16)}-${mtimeMs.toString(16)}"`;
    headers['Last-Modified']=new Date(mtimeMs).toUTCString();
    const matches=req.headers['if-none-match']?.split(',').map(value=>value.trim()).some(value=>value==='*'||value.replace(/^W\//,'')===headers.ETag);
    const since=!req.headers['if-none-match']&&req.headers['if-modified-since']&&Date.parse(req.headers['if-modified-since'])>=Math.floor(mtimeMs/1000)*1000;
    if(matches||since){res.writeHead(304,headers);res.end();return;}
    if(req.headers['if-range']&&req.headers['if-range']!==headers.ETag&&!(Date.parse(req.headers['if-range'])>=Math.floor(mtimeMs/1000)*1000))req.headers.range=undefined;
  }
  let start=0,end=size-1,status=200;
  if(req.headers.range){
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    if(!match[1])start=Math.max(0,size-Number(match[2]));
    else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers);
  if(req.method==='HEAD'||!size){res.end();return;}
  const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
}
export async function createApp({storageRoot=resolve(root,'data'),sendAuthCode,ffmpeg,generationFetch,generationTimeoutMs,captchaFactory,registrationEmailDomains}={}){
  const store=createStore(storageRoot);
  const auth=createAuthStore(storageRoot,{sendCode:sendAuthCode,captchaFactory,registrationEmailDomains});
  const generations=createGenerationStore(storageRoot);
  const generationService=createGenerationService(storageRoot,generations,{fetchImpl:generationFetch,timeoutMs:generationTimeoutMs});
  const derivatives=createDerivatives(storageRoot,{ffmpeg});
  let activeUploads=0,uploadBytes=0;
  await Promise.all([store.ready,auth.ready,generations.ready,derivatives.ready,generationService.ready]);
  const assert=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
  const sessionUser=async req=>auth.sessionUser(cookieValue(req,SESSION_COOKIE));
  async function withAuthors(works){
    const profiles=await auth.profilesByIds([...new Set(works.map(work=>work.authorId).filter(Boolean))]);
    const enabled=await derivatives.ready;
    return works.map(work=>{
      const profile=profiles.get(work.authorId)||null;
      return {...work,author:profile?.deleted?'已注销用户':work.author,media:work.media.map(media=>({...media,...(enabled?{thumbnailUrl:`/thumbnails/${media.id}/640.jpg`,thumbnailSmall:`/thumbnails/${media.id}/320.jpg`,thumbnailLarge:`/thumbnails/${media.id}/1280.jpg`}:{})})),authorProfile:profile};
    });
  }
  async function listResponse(req,works,extra={}){
    const params=new URL(req.url,'http://localhost').searchParams;
    if(!params.has('limit')&&!params.has('cursor')&&!params.has('cards'))return {works:await withAuthors(works),...extra};
    const result=queryWorks(works,params);
    return {...result,works:await withAuthors(result.works.map(workCard)),...extra};
  }
  const requireUser=async req=>{
    const user=await sessionUser(req);
    if(!user)throw new HttpError(401,'请先登录。');
    return user;
  };
  const requireAdmin=async req=>{
    const user=await requireUser(req);
    assert(user.role==='admin','仅管理员可以访问管理后台。',403);
    return user;
  };
  const metrics=()=>({uploads:{active:activeUploads,reservedBytes:uploadBytes},storage:store.metrics(),derivatives:derivatives.metrics(),memory:process.memoryUsage()});
  // 作者本人可管理；无归属的历史作品保持原有本地行为，仅限登录用户。
  async function requireWorkOwner(req,id){
    const user=await requireUser(req);
    const work=await store.get(id);
    assert(work,'作品不存在。',404);
    const author=work.authorId?await auth.userById(work.authorId):null,authorDeleted=Boolean(author?.deletedAt);
    assert(work.status!=='withdrawn'||work.authorId===user.id||(user.role==='admin'&&authorDeleted),'下架作品仅创作者本人可以操作。',403);
    assert(!work.authorId||work.authorId===user.id||user.role==='admin','只能管理自己发布的作品。',403);
    return {user,work,authorDeleted};
  }
  const server=createServer(async(req,res)=>{
    try{
      const host=req.headers.host||'';
      if(!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host))throw new HttpError(403,'只允许从本机访问。');
      let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{throw new HttpError(400,'请求路径不正确。');}
      // ---- 账号与个人资料 ----
      if(path==='/api/admin/generation-config'&&req.method==='GET'){
        await requireAdmin(req);json(res,200,await generationService.settings(true));return;
      }
      if(path==='/api/admin/generation-config'&&req.method==='PUT'){
        sameOrigin(req);const actor=await requireAdmin(req),input=await readJson(req,32768);
        await auth.assertActiveAdmin(actor.id);
        json(res,200,await generationService.save(input));return;
      }
      if(path==='/api/admin/generation-models'&&req.method==='POST'){
        sameOrigin(req);const actor=await requireAdmin(req),input=await readJson(req,32768);
        await auth.assertActiveAdmin(actor.id);
        json(res,200,await generationService.models(input));return;
      }
      if(path==='/api/generation/config'&&req.method==='GET'){
        await requireUser(req);json(res,200,await generationService.settings());return;
      }
      if(path==='/api/generations'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);
        assert(req.headers['content-type']?.startsWith('multipart/form-data;'),'请使用文件上传表单。',415);
        const reserved=Number(req.headers['content-length'])||limits.total+1024**2;
        assert(reserved<=limits.total+1024**2,'参考图内容过大。',413);
        assert(activeUploads<2&&uploadBytes+reserved<=256*1024**2,'上传繁忙，请稍后重试。',503);
        activeUploads++;uploadBytes+=reserved;
        let upload,released=false;
        try{
          upload=await readMultipart(req);
          activeUploads--;uploadBytes-=reserved;released=true;
          const generation=await generationService.generate(upload.metadata,upload.files,user);
          json(res,200,{generation});return;
        }finally{try{await upload?.cleanup();}finally{if(!released){activeUploads--;uploadBytes-=reserved;}}}
      }
      if(path==='/api/admin/metrics'&&req.method==='GET'){await requireAdmin(req);json(res,200,metrics());return;}
      if(path==='/api/admin/users'&&req.method==='GET'){
        await requireAdmin(req);
        const params=new URL(req.url,'http://localhost').searchParams,stats=await store.statsByAuthor();
        const result=await auth.listUsersForAdmin({
          q:params.get('q')||'',role:params.get('role')||'all',status:params.get('status')||'all',
          creatorStatus:params.get('creatorStatus')||'all',kind:params.get('kind')||'all',
          page:params.get('page')||1,limit:params.get('limit')||20
        });
        result.users=result.users.map(user=>({...user,works:stats.get(user.id)||{total:0,published:0,pending:0,draft:0,rejected:0,withdrawn:0,deleted:0}}));
        json(res,200,result);return;
      }
      const adminUserAction=/^\/api\/admin\/users\/(user-[0-9a-f-]{36})$/.exec(path);
      if(adminUserAction&&req.method==='PATCH'){
        sameOrigin(req);const actor=await requireAdmin(req),input=await readJson(req,8192);
        json(res,200,{user:await auth.adminUpdateUser(actor.id,adminUserAction[1],input)});return;
      }
      if(adminUserAction&&req.method==='DELETE'){
        sameOrigin(req);const actor=await requireAdmin(req),input=await readJson(req,8192);
        json(res,200,{user:await auth.adminDeleteUser(actor.id,adminUserAction[1],{confirmEmail:input.confirmEmail})});return;
      }
      if(path==='/api/auth/me'&&req.method==='GET'){
        const user=await sessionUser(req);
        json(res,200,{user:user?auth.publicUser(user):null,emailDelivery:emailDeliveryMode()});return;
      }
      if(path==='/api/auth/captcha'&&req.method==='GET'){
        json(res,200,await auth.createCaptcha());return;
      }
      if(path==='/api/auth/code'&&req.method==='POST'){
        sameOrigin(req);
        const input=await readJson(req);
        json(res,200,await auth.requestCode(input.email,{purpose:'register',requireNew:true}));return;
      }
      if(path==='/api/auth/password/reset/code'&&req.method==='POST'){
        sameOrigin(req);
        const input=await readJson(req);
        json(res,200,await auth.requestCode(input.email,{purpose:'reset',requireExisting:true}));return;
      }
      if(path==='/api/auth/password/code'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);
        json(res,200,await auth.requestCode(user.email,{purpose:'password',requireExisting:true}));return;
      }
      if(path==='/api/auth/login'&&req.method==='POST'){
        sameOrigin(req);const input=await readJson(req);
        const user=await auth.loginWithPassword(input.email,input.password);
        const {token}=await auth.createSession(user.id);
        res.setHeader('Set-Cookie',sessionCookie(token,SESSION_TTL/1000));
        json(res,200,{user:auth.publicUser(user)});return;
      }
      if(path==='/api/auth/register'&&req.method==='POST'){
        sameOrigin(req);const input=await readJson(req);
        const user=await auth.register(input);
        const {token}=await auth.createSession(user.id);
        res.setHeader('Set-Cookie',sessionCookie(token,SESSION_TTL/1000));
        json(res,200,{user:auth.publicUser(user)});return;
      }
      if(path==='/api/auth/password/reset'&&req.method==='POST'){
        sameOrigin(req);const input=await readJson(req);
        await auth.resetPassword(input);
        json(res,200,{ok:true});return;
      }
      if(path==='/api/user/password'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);
        const updated=await auth.changePassword(user.id,await readJson(req));
        json(res,200,{ok:true,user:auth.publicUser(updated)});return;
      }
      if(path==='/api/user/onboarding'&&req.method==='PATCH'){
        sameOrigin(req);const user=await requireUser(req);
        const updated=await auth.completeOnboarding(user.id,await readJson(req));
        json(res,200,{user:auth.publicUser(updated)});return;
      }
      if(path==='/api/auth/logout'&&req.method==='POST'){
        sameOrigin(req);
        await auth.destroySession(cookieValue(req,SESSION_COOKIE));
        res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        json(res,200,{ok:true});return;
      }
      if(path==='/api/user/profile'&&req.method==='PATCH'){
        sameOrigin(req);const user=await requireUser(req);
        const input=await readJson(req);
        // 社交主页是创作者的展示材料，仅审核通过的创作者（或管理员）可维护。
        if(input.social!==undefined&&(user.creatorStatus||'none')!=='approved'&&user.role!=='admin')throw new HttpError(403,'成为创作者后才能维护社交主页。');
        const updated=await auth.updateProfile(user.id,{nickname:input.nickname,social:input.social===undefined?undefined:socialLinks(input.social)});
        json(res,200,{user:auth.publicUser(updated)});return;
      }
      if(path==='/api/user/creator-application'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);
        const input=await readJson(req);
        const updated=await auth.requestCreator(user.id,{social:input.social});
        json(res,200,{user:auth.publicUser(updated)});return;
      }
      if(path==='/api/user/works'&&req.method==='GET'){
        const user=await requireUser(req);
        json(res,200,await listResponse(req,await store.listByAuthor(user.id,{includeUnowned:true})));return;
      }
      if(path==='/api/user/generations'&&req.method==='GET'){
        const user=await requireUser(req);
        const enabled=await derivatives.ready;
        const records=await generations.listByAuthor(user.id);
        json(res,200,{generations:records.map(record=>({...record,media:record.media.map(media=>({...media,...(enabled?{thumbnailUrl:`/generation-thumbnails/${media.id}/640.jpg`,thumbnailSmall:`/generation-thumbnails/${media.id}/320.jpg`,thumbnailLarge:`/generation-thumbnails/${media.id}/1280.jpg`}:{})}))}))});return;
      }
      const generationRecord=/^\/api\/generations\/(generation-[0-9a-f-]{36})$/.exec(path);
      if(generationRecord&&req.method==='DELETE'){
        sameOrigin(req);const user=await requireUser(req);
        const record=await generations.get(generationRecord[1]);
        assert(record&&record.authorId===user.id,'生成记录不存在。',404);
        // 投稿作品以生成记录作为来源凭证，必须先移除对应作品再删除记录。
        const submitted=(await store.listByAuthor(user.id)).some(work=>work.generationId===record.id);
        assert(!submitted,'这条生成记录已用于投稿，请先在「我的作品」中下架并删除对应作品。',409);
        const removed=await generations.remove(record.id,user.id);
        await Promise.all(removed.media.map(media=>derivatives.remove(media.id)));
        json(res,200,{deleted:removed.id});return;
      }
      const userPage=/^\/api\/users\/(user-[0-9a-f-]{36})\/works$/.exec(path);
      if(userPage&&req.method==='GET'){
        const target=await auth.userById(userPage[1]);
        if(!target)throw new HttpError(404,'用户不存在。');
        const works=(await store.listByAuthor(target.id)).filter(work=>(work.status||'published')==='published');
        json(res,200,await listResponse(req,works,{user:auth.profileUser(target)}));return;
      }
      // ---- 作品审核（管理员） ----
      if(path==='/api/admin/works'&&req.method==='GET'){
        await requireAdmin(req);
        const status=new URL(req.url,'http://localhost').searchParams.get('status')||'pending';
        json(res,200,await listResponse(req,await store.listByStatus(status)));return;
      }
      const reviewAction=/^\/api\/admin\/works\/(work-[0-9a-f-]{36})\/review$/.exec(path);
      if(reviewAction&&req.method==='POST'){
        sameOrigin(req);const actor=await requireAdmin(req);
        const input=await readJson(req);
        const work=await store.review(reviewAction[1],{decision:input.decision,note:input.note,expectedRevision:input.expectedRevision,verifyActor:()=>auth.assertActiveAdmin(actor.id)});
        json(res,200,{work:(await withAuthors([work]))[0]});return;
      }
      // ---- 创作者申请审核（管理员） ----
      if(path==='/api/admin/creators'&&req.method==='GET'){
        await requireAdmin(req);
        const status=new URL(req.url,'http://localhost').searchParams.get('status')||'pending';
        json(res,200,{users:await auth.listCreators(status)});return;
      }
      const creatorReviewAction=/^\/api\/admin\/creators\/(user-[0-9a-f-]{36})\/review$/.exec(path);
      if(creatorReviewAction&&req.method==='POST'){
        sameOrigin(req);const actor=await requireAdmin(req);
        const input=await readJson(req);
        const user=await auth.reviewCreator(creatorReviewAction[1],{decision:input.decision,note:input.note,actorId:actor.id});
        json(res,200,{user:auth.publicUser(user)});return;
      }
      // ---- 作品 ----
      if(path==='/api/works'&&req.method==='GET'){json(res,200,await listResponse(req,await store.list(),{limits}));return;}
      const detail=/^\/api\/works\/(work-[0-9a-f-]{36})$/.exec(path);
      if(detail&&req.method==='GET'){
        const work=await store.get(detail[1]);
        assert(work&&!work.deletedAt,'作品不存在。',404);
        if((work.status||'published')!=='published'){
          const user=await sessionUser(req);
          assert(user&&(work.authorId===user.id||user.role==='admin'),'作品不存在。',404);
        }
        json(res,200,{work:(await withAuthors([work]))[0]});return;
      }
      if(path==='/api/works'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);
        if(!req.headers['content-type']?.startsWith('multipart/form-data;'))throw new HttpError(415,'请使用文件上传表单。');
        const reserved=Number(req.headers['content-length'])||limits.total+1024**2;
        assert(reserved<=limits.total+1024**2,'上传内容过大。',413);
        if(activeUploads>=2||uploadBytes+reserved>256*1024**2){res.setHeader('Retry-After','2');throw new HttpError(503,'上传繁忙，请稍后重试。');}
        activeUploads++;uploadBytes+=reserved;
        let upload;
        try{
        upload=await readMultipart(req);
        const {metadata,files}=upload;
        const existing=await store.get(metadata?.id);
        assert(existing?.status!=='withdrawn'||existing.authorId===user.id,'下架作品仅创作者本人可以操作。',403);
        if(existing?.authorId&&existing.authorId!==user.id&&user.role!=='admin')throw new HttpError(403,'只能修改自己发布的作品。');
        // 新发布需要创作者身份（编辑已有作品仅要求作者本人）。
        if((!existing||existing.status==='draft')&&(user.creatorStatus||'none')!=='approved'&&user.role!=='admin')throw new HttpError(403,'发布作品需要创作者身份，请在个人资料页申请认证。');
        let generation=null;
        if(metadata?.generationId){
          const record=await generations.get(metadata.generationId);
          assert(record&&record.authorId===user.id,'只能投稿本人在创作台生成的图片。',403);
          assert(!existing||existing.generationId===record.id,'已有作品不能改为其他生成结果。',409);
          const indexes=[],usedOutputs=new Set();
          assert(Array.isArray(metadata.media),'附件信息不正确。');
          for(const item of metadata.media){
            const output=record.media.find(media=>media.id===item?.existing);
            if(!output)continue;
            assert(!usedOutputs.has(output.id),'生成图片不能重复投稿到同一作品。');usedOutputs.add(output.id);
            const index=files.length;files.push(await generations.imageFile(output));indexes.push(index);
            item.file=index;delete item.existing;
          }
          assert(indexes.length>0||existing?.generationMediaIds?.some(id=>metadata.media.some(item=>item?.existing===id)),'投稿需要保留创作台生成的图片。');
          generation={id:record.id,indexes,modelId:record.modelId};
        }
        const work=await store.save(metadata,files,{id:user.id,nickname:user.nickname,generation});json(res,200,{work:(await withAuthors([work]))[0]});return;
        }finally{activeUploads--;uploadBytes-=reserved;await upload?.cleanup();}
      }
      const withdrawAction=/^\/api\/works\/(work-[0-9a-f-]{36})\/withdraw$/.exec(path);
      if(withdrawAction&&req.method==='POST'){
        sameOrigin(req);const {user}=await requireWorkOwner(req,withdrawAction[1]);
        const input=await readJson(req);
        const work=await store.withdraw(withdrawAction[1],input.revision,user.id,{note:input.note,requireNote:user.role==='admin'});
        json(res,200,{work:(await withAuthors([work]))[0]});return;
      }
      const workAction=/^\/api\/works\/(work-[0-9a-f-]{36})(\/restore)?$/.exec(path);
      if(workAction&&((!workAction[2]&&req.method==='DELETE')||(workAction[2]&&req.method==='POST'))){
        sameOrigin(req);const {user,authorDeleted}=await requireWorkOwner(req,workAction[1]);
        let input;try{input=JSON.parse((await body(req,1024)).toString());}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'请求格式不正确。');}
        if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'请求格式不正确。');
        json(res,200,{work:(await withAuthors([await store.setDeleted(workAction[1],!workAction[2],input.revision,user.id,{allowDeletedAuthor:user.role==='admin'&&authorDeleted})]))[0]});return;
      }
      if(!['GET','HEAD'].includes(req.method))throw new HttpError(405,'不支持此请求方式。');
      const generatedThumbnail=/^\/generation-thumbnails\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif))\/(320|640|1280)\.jpg$/.exec(path);
      if(generatedThumbnail){
        const media=await generations.media(generatedThumbnail[1]),user=await sessionUser(req);
        assert(user&&user.id===media.authorId,'生成图片不存在。',404);res.setHeader('Cache-Control','private, no-store');
        const file=await derivatives.file(media,generatedThumbnail[1],Number(generatedThumbnail[2]));
        serveFile(req,res,file.path,file.size);return;
      }
      const thumbnail=/^\/thumbnails\/([0-9a-f-]{36}\.(?:jpg|png|webp|gif|mp4|webm))\/(320|640|1280)\.jpg$/.exec(path);
      if(thumbnail){
        const media=await store.media(thumbnail[1]);
        if(media.private){const user=await sessionUser(req);assert(user&&(!media.privateOwnerIds.length||media.privateOwnerIds.includes(user.id)||user.role==='admin'),'附件不存在。',404);res.setHeader('Cache-Control','private, no-store');}
        const file=await derivatives.file(media,thumbnail[1],Number(thumbnail[2]));
        // Visibility may change during decoding; validate it again before serving any bytes or 304.
        const latest=await store.media(thumbnail[1]);
        if(latest.private){const user=await sessionUser(req);assert(user&&(!latest.privateOwnerIds.length||latest.privateOwnerIds.includes(user.id)||user.role==='admin'),'附件不存在。',404);res.setHeader('Cache-Control','private, no-store');}
        serveFile(req,res,file.path,file.size,file.mtimeMs);return;
      }
      if(path.startsWith('/generation-media/')){
        const media=await generations.media(path.slice('/generation-media/'.length)),user=await sessionUser(req);
        assert(user&&user.id===media.authorId,'生成图片不存在。',404);
        res.setHeader('Cache-Control','private, no-store');serveFile(req,res,media.path,media.size);return;
      }
      if(path.startsWith('/media/')){
        const media=await store.media(path.slice(7));
        if(media.private){
          const user=await sessionUser(req);
          assert(user&&(!media.privateOwnerIds.length||media.privateOwnerIds.includes(user.id)||user.role==='admin'),'附件不存在。',404);
          res.setHeader('Cache-Control','private, no-store');
        }
        serveFile(req,res,media.path,media.size,media.mtimeMs);return;
      }
      if(path==='/')path='/index.html';
      const file=resolve(root,'.'+path);
      if(!file.startsWith(root+sep)||(!publicFiles.has(path)&&!/^\/assets\/[\w-]+\.(jpg|png|webp|svg)$/.test(path)))throw new HttpError(404,'Not found');
      const info=await stat(file);if(!info.isFile())throw new HttpError(404,'Not found');serveFile(req,res,file,info.size);
    }catch(error){
      if(res.headersSent||res.destroyed){res.destroy();return;}
      const status=error.status||(error.code==='ENOENT'?404:['EMFILE','ENFILE','EIO','EBUSY'].includes(error.code)?503:500);
      if(status===503)res.setHeader('Retry-After','2');
      if(status===500)console.error('Request failed:',req.method,req.url,error.stack||error.message);
      json(res,status,{error:status===500?'保存失败，请检查磁盘空间后重试。':status===503&&!error.status?'存储暂时不可用，请稍后重试。':error.message});
    }
  });
  server.requestTimeout=300000;
  server.on('close',()=>{store.close();generations.close();derivatives.close();});
  return {server,store,auth,generations,metrics};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await loadMailConfig(resolve(root,'mail.local.json'));
  const {server}=await createApp();server.listen(5173,'127.0.0.1',()=>console.log('LumaVision: http://localhost:5173'));
}
