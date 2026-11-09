import { prompts, categories } from './data.js';
import { createUploader, publishWork } from './media.js';
import { createAuthDialog } from './auth-ui.js';
import { draftPreview } from './drafts.js';
import { studioTabs, studioItems } from './studio.js';
import { createGenerationUI } from './generation-ui.js';

const icons = {
 home:'m3 10 9-7 9 7v11h-6v-7H9v7H3z', update:'M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6', withdraw:'M12 3v12m-4-4 4 4 4-4M4 19h16',
 plus:'M12 5v14M5 12h14', x:'m6 6 12 12M18 6 6 18', search:'M21 21l-4.4-4.4M19 10.8a8.2 8.2 0 1 1-16.4 0 8.2 8.2 0 0 1 16.4 0',
 image:'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3 17l6-6 5 5 3-3 4 4M16 7h.01',
 video:'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 9h18M7 5l3 4M14 5l3 4',
 heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
 bookmark:'M6 3h12v18l-6-4-6 4z', 'arrow-up-right':'M7 17 17 7M7 7h10v10', arrow:'M4 12h16m-6-6 6 6-6 6',
 more:'M12 5h.01M12 12h.01M12 19h.01', share:'M21 3 9 10l-6-1 18-6-6 18-3-7M9 10l3 4', sliders:'M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6', sort:'M4 6h16M4 12h11M4 18h6',
 sparkles:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4', copy:'M9 8h11v13H9zM15 8V3H4v13h5', play:'m9 5 10 7-10 7z', check:'m5 12 4 4L19 6', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', edit:'m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z',
 user:'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0', logout:'M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9'
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] || icons.sparkles}"/></svg>`;
const $ = (selector) => document.querySelector(selector);
const escape = (text = '') => String(text).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
let storageIssue = false;
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(`luma-${key}`)) ?? fallback; } catch { storageIssue = true; return fallback; } }
function write(key, value) { try { localStorage.setItem(`luma-${key}`, JSON.stringify(value)); return true; } catch { toast('浏览器无法保存数据，请导出提示词留存。'); return false; } }
const storedDrafts = read('drafts', []);
const safeDrafts = Array.isArray(storedDrafts) ? storedDrafts.filter(p => p && typeof p.id === 'string' && p.id.startsWith('custom-') && typeof p.title === 'string' && typeof p.prompt === 'string' && ['image','video'].includes(p.type) && Array.isArray(p.tags)) : [];
const storedSaved = read('saved', []);
const workStatusLabels={draft:'草稿',pending:'审核中',rejected:'审核驳回',withdrawn:'作品下架'};
const state = { view:'explore', type:'all', category:'全部灵感', query:'', model:'all', sort:'featured', workStatus:'all', saved:new Set(Array.isArray(storedSaved) ? storedSaved.filter(x=>typeof x==='string') : []), drafts:safeDrafts, works:[], user:null, emailDelivery:'demo', myWorks:[], viewUser:null, userWorks:[], userViewId:null, reviewPending:[], reviewRejected:[], creatorPending:[] };
const storedStudioTab=read('studio-tab','drafts');
state.studioTab=Object.hasOwn(studioTabs,storedStudioTab)?storedStudioTab:'drafts';
state.generations=[];
state.generationError=false;
let generationSeq=0;
const allPrompts = () => [...state.works, ...prompts];
// 作品查找包含“我的作品/审核列表”，让待审核、已驳回的作品仍能打开详情。
let workMap=new Map(),workMapSources=[];
function findWork(id){
  const sources=[state.drafts,state.generations,state.myWorks,state.userWorks,state.reviewPending,state.reviewRejected,state.works,prompts];
  if(sources.some((source,index)=>source!==workMapSources[index])){
    workMap=new Map();for(const source of sources)for(const work of source)if(!workMap.has(work.id))workMap.set(work.id,work);
    workMapSources=sources;
  }
  const work=workMap.get(id);
  if(work?.uploaded&&work.status&&work.status!=='published'&&(!state.user||(work.authorId!==state.user.id&&state.user.role!=='admin')))return null;
  return work;
}
const SOCIAL_PLATFORMS = {instagram:'Instagram',x:'X',threads:'Threads',tiktok:'TikTok',youtube:'YouTube',facebook:'Facebook',pinterest:'Pinterest',behance:'Behance',deviantart:'DeviantArt',kofi:'Ko-fi'};
const SOCIAL_TIP = '会展示在你发布的全部作品上，其他用户点击你的头像即可访问。支持 Instagram、X、Threads、TikTok、YouTube、Facebook、Pinterest、Behance、DeviantArt、Ko-fi。';
const AVATAR_COLORS = ['#6470b8','#5f8d7e','#b0785f','#8a6aa0','#5b8dbd','#bd6a8a','#6b7f95'];
function avatarColor(id){let hash=0;for(const ch of String(id||''))hash=(hash*31+ch.charCodeAt(0))>>>0;return AVATAR_COLORS[hash%AVATAR_COLORS.length];}
function avatarHtml(user,size=32){
  if(user?.avatarUrl)return `<img class="avatar" style="width:${size}px;height:${size}px" src="${escape(user.avatarUrl)}" alt="" referrerpolicy="no-referrer">`;
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${avatarColor(user?.id)}">${escape((user?.nickname||'客').trim().slice(0,1).toUpperCase()||'客')}</span>`;
}
// 服务端已校验社交链接的域名白名单；此处再拦一道协议，防止异常数据把 javascript: 带进 href。
const safeSocialUrl=url=>{try{return new URL(url).protocol==='https:'?url:null;}catch{return null;}};
const socialLinksHtml=social=>Object.entries(social||{}).map(([key,raw])=>{const url=safeSocialUrl(raw);return url?`<a class="social-link" href="${escape(url)}" target="_blank" rel="noreferrer">${escape(SOCIAL_PLATFORMS[key]||key)}<span data-icon="arrow-up-right"></span></a>`:'';}).join('');
function creatorSocial(social){
  const entries=Object.entries(social||{}).filter(([key,url])=>SOCIAL_PLATFORMS[key]&&safeSocialUrl(url));
  const entry=entries.find(([key])=>key==='x')||entries[0];
  if(!entry)return null;
  const [key,url]=entry,parts=new URL(url).pathname.split('/').filter(Boolean);
  let username='';
  const reserved={x:['home','explore','search','i','intent','share'],instagram:['p','reel','reels','stories','explore'],threads:['post'],tiktok:['video','discover'],youtube:['watch','shorts','playlist','channel','feed'],facebook:['profile.php','pages','groups','watch','share','reel'],pinterest:['pin','ideas','search'],behance:['gallery','search'],deviantart:['art','users','search'],kofi:['s','post']};
  if(key==='youtube')username=parts[0]?.startsWith('@')?parts[0]:['user','c'].includes(parts[0])?parts[1]||'':'';
  else if(!reserved[key]?.includes(parts[0]?.toLowerCase()))username=parts[0]||'';
  if(['threads','tiktok'].includes(key)&&!username.startsWith('@'))username='';
  try{username=decodeURIComponent(username);}catch{username='';}
  const handle=username?'@'+username.replace(/^@/,''):'';
  return {key,url,handle,name:SOCIAL_PLATFORMS[key]};
}
let currentPrompt = null, editingId = null, toastTimer, removedDraft = null;
let uploader=null, publishing=false, editingRecord=null, uploadId=null, lastSubmission=null, activeMedia=0;
let sessionPromise=null, pageSeq=0, myWorksSeq=0, publicWorksSeq=0;
let sessionEpoch=0,detailSeq=0;
let galleryKey='',galleryCursor=null,galleryTotal=0,galleryLoading=false,gallerySeq=0;
let galleryHistory=[],galleryCurrentCursor=null;
function galleryParams(){
  const params=new URLSearchParams({limit:'36',cards:'1',type:state.type,category:state.category==='全部灵感'?'all':state.category,model:state.model,q:state.query,sort:state.view==='creations'?'updated':state.sort==='popular'?'popular':'newest'});
  if(state.view==='collections')params.set('ids',[...state.saved].filter(id=>id.startsWith('work-')).join(','));
  if(state.view==='creations')params.set('workStatus',state.workStatus==='all'?'visible':state.workStatus);
  return params;
}
function galleryEndpoint(){return state.view==='creations'?'/api/user/works':['explore','recent','collections'].includes(state.view)?'/api/works':null;}
async function loadGalleryPage(cursor=null){
  const endpoint=galleryEndpoint();if(!endpoint||endpoint==='/api/user/works'&&!state.user)return;
  const params=galleryParams(),key=endpoint+'?'+params,seq=++gallerySeq,epoch=sessionEpoch;
  galleryKey=key;galleryLoading=true;if(cursor)params.set('cursor',cursor);
  try{
    const data=await requestJson(endpoint+'?'+params);
    if(seq!==gallerySeq||epoch!==sessionEpoch||key!==galleryKey)return;
    if(endpoint==='/api/user/works')state.myWorks=data.works||[];else state.works=data.works||[];
    galleryCursor=data.nextCursor;galleryTotal=data.total;galleryCurrentCursor=cursor;
    $('#works-status').hidden=true;
  }catch(error){
    if(seq!==gallerySeq||epoch!==sessionEpoch)return;
    if(error.status===409&&cursor){galleryHistory=[];galleryKey='';}
    else {$('#works-status').hidden=false;$('#works-status').textContent=error.message||'作品加载失败，请重试。';}
  }finally{if(seq===gallerySeq){galleryLoading=false;render();}}
}
function refreshGallery(){
  const endpoint=galleryEndpoint();if(!endpoint||endpoint==='/api/user/works'&&!state.user)return;
  const key=endpoint+'?'+galleryParams();
  if(key!==galleryKey){galleryHistory=[];galleryCursor=null;galleryCurrentCursor=null;loadGalleryPage();}
}
function clearPrivateSession(){
  sessionEpoch++;detailSeq++;pageSeq++;invalidateWorkReads();generationSeq++;
  gallerySeq++;galleryKey='';galleryLoading=false;galleryHistory=[];galleryCursor=null;galleryCurrentCursor=null;galleryTotal=0;
  state.myWorks=[];state.generations=[];state.reviewPending=[];state.reviewRejected=[];state.creatorPending=[];
  state.userWorks=[];state.viewUser=null;state.userViewId=null;state.generationError=false;
  state.reviewTotal=0;state.userWorksTotal=0;userCursor=null;userHistory=[];userCurrentCursor=null;
  currentPrompt=null;editingRecord=null;editingId=null;removedDraft=null;lastSubmission=null;
  for(const id of ['detail','editor','creator','reject','confirm','profile','password','generation-settings']){const dialog=$('#'+id);if(dialog?.open)dialog.close();}
  $('#detail').innerHTML='';$('#page-view').innerHTML='';$('#studio-status').hidden=true;
  workMap.clear();workMapSources=[];
}
function invalidateWorkReads(){myWorksSeq++;publicWorksSeq++;}
async function loadWorks(){
  if(galleryEndpoint()){galleryKey='';await loadGalleryPage();return true;}
  const seq=++publicWorksSeq;
  try{const response=await fetch('/api/works',{cache:'no-store'});if(!response.ok)throw new Error();const data=await response.json();if(!Array.isArray(data.works))throw new Error();if(seq!==publicWorksSeq)return false;state.works=data.works;$('#works-status').hidden=true;render();if(location.hash.startsWith('#prompt/'))route();return true;}
  catch{$('#works-status').hidden=false;$('#works-status').innerHTML='暂时无法读取已上传的作品，现有内容不会被清空。<button data-action="reload-works">重新加载</button>';return false;}
}

// ===== 账号：登录 / 资料 / 主页 / 审核 =====
async function requestJson(url,options={}){
  const epoch=sessionEpoch;
  const response=await fetch(url,{headers:{'Content-Type':'application/json'},cache:'no-store',...options,body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json().catch(()=>({}));
  if(epoch!==sessionEpoch){const error=new Error('账号已切换，请重新打开当前页面。');error.status=409;throw error;}
  if(!response.ok){const error=new Error(data.error||'请求失败，请稍后再试。');error.status=response.status;throw error;}
  return data;
}
async function loadSession(){
  const epoch=sessionEpoch;
  try{
    const response=await fetch('/api/auth/me',{cache:'no-store'});
    // 404 说明服务端进程是旧版本：磁盘上的前端已是新版，但 API 还没有登录路由。
    if(response.status===404)toast('登录服务不可用：服务器可能是旧版本，请重启 node server.mjs 后刷新页面。');
    else if(response.ok){const data=await response.json();if(epoch!==sessionEpoch)return;state.user=data.user||null;state.emailDelivery=data.emailDelivery||'unavailable';}
  }
  catch{if(epoch!==sessionEpoch)return;state.user=null;}
  renderAccount();
  if(state.user){await Promise.all([loadMyWorks(),loadGenerations()]);if(state.user?.onboardingComplete===false)authDialog.openSetup(state.user);}
}
async function loadMyWorks(){
  const userId = state.user?.id;
  if (!userId) return;
  if(state.view==='creations'){await loadGalleryPage();if(location.hash.startsWith('#prompt/'))route();return;}
  const seq=++myWorksSeq;
  try{
    const data = await requestJson('/api/user/works?limit=100&cards=1&sort=updated');
    if (state.user?.id !== userId||seq!==myWorksSeq) return;
    state.myWorks = Array.isArray(data.works) ? data.works : [];
  }
  catch{if (state.user?.id !== userId||seq!==myWorksSeq) return; state.myWorks=[];}
  render();
  if(state.view==='profile')renderPageView();
  if(location.hash.startsWith('#prompt/'))route();
}
async function loadGenerations(){
  const userId=state.user?.id,seq=++generationSeq;if(!userId)return;
  try{
    const data=await requestJson('/api/user/generations');
    if(state.user?.id!==userId||seq!==generationSeq)return;
    state.generations=Array.isArray(data.generations)?data.generations:[];state.generationError=false;
  }catch{
    if(state.user?.id!==userId||seq!==generationSeq)return;
    state.generationError=true;$('#studio-status').textContent='暂时无法读取生成记录，请刷新页面重试。';
  }
  render();
  if(location.hash.startsWith('#prompt/'))route();
}
function applySession(user){if(state.user?.id!==user?.id)clearPrivateSession();state.user=user;state.generations=[];state.generationError=false;renderAccount();loadMyWorks();loadGenerations();}
async function logout(){
  try{await requestJson('/api/auth/logout',{method:'POST'});}catch(error){toast(error.message || '退出登录失败，请重试。');return;}
  clearPrivateSession();state.user=null;renderAccount();render();
  if(['profile','review'].includes(state.view)||state.view==='user')go('explore');
  toast('已退出登录');
}
function renderAccount(){
  const reviewNav=document.querySelector('[data-view="review"]');if(reviewNav)reviewNav.hidden=state.user?.role!=='admin';
  renderViewActions();
  const host=$('#account-area');if(!host)return;
  if(!state.user){host.innerHTML=`<button class="account-chip account-start" data-action="login"><span>开始使用</span>${icon('arrow')}</button>`;return;}
  host.innerHTML=`<details class="account-menu"><summary class="account-chip logged-in">${avatarHtml(state.user,26)}<span class="account-name">${escape(state.user.nickname)}</span></summary><div class="account-drop"><button data-action="open-profile">${icon('user')}个人资料</button><button data-action="open-my-page">${icon('arrow-up-right')}我的主页</button>${state.user.role==='admin'?`<button data-action="generation-settings">${icon('sliders')}生图服务</button><button data-action="open-review">${icon('check')}审核管理</button>`:''}<button data-action="logout">${icon('logout')}退出登录</button></div></details>`;
}
function renderViewActions(){
  $('#publish-work').hidden=state.view!=='creations'||state.user?.accountType!=='creator';
  $('#start-creation').hidden=state.view!=='drafts';
}
const generationUI=createGenerationUI({
  request:requestJson,session:()=>({user:state.user,epoch:sessionEpoch}),escape,toast,
  login:()=>{
    const draft={...getCreative(),id:creativeDraftId,custom:true};
    const localReferences=creativeRefs.filter(ref=>ref.file);
    afterLogin=async()=>{
      await openCreator(draft);
      if(!$('#creator').open)return;
      creativeRefs.push(...localReferences.map(ref=>({...ref,url:URL.createObjectURL(ref.file)})));
      renderCreativeRefs();
    };
    openLogin();
  },
  completed:(record,show)=>{
    state.generations=[record,...state.generations.filter(item=>item.id!==record.id)];
    render();toast('图片已生成，保存在私有生成记录中。');
    if(show){$('#creator').close();openPrompt(record.id);}
    loadGenerations();
  }
});
let afterLogin=null;
const authDialog = createAuthDialog({
  dialog: $('#auth'), request: requestJson, emailMode: () => state.emailDelivery,
  onVerified: user => { applySession(user); if(state.view==='profile')renderProfile(); },
  platforms: SOCIAL_PLATFORMS, escape, icon,
  onDismiss: () => { afterLogin = null; },
  onAuthenticated: (user, isRegister) => {
    const next = afterLogin;
    afterLogin = null;
    if (isRegister && user.creatorStatus === 'pending' && user.role !== 'admin') toast(`欢迎，${user.nickname}！创作者申请已提交，审核通过后即可发布作品`);
    else toast(isRegister ? `欢迎加入，${user.nickname}` : `欢迎回来，${user.nickname}`);
    if (state.view === 'profile') renderProfile();
    next?.();
  }
});
async function openLogin(){
  if (sessionPromise) await sessionPromise;
  if (state.user) { const next = afterLogin; afterLogin = null; next?.(); return; }
  if ($('#detail').open) $('#detail').close();
  authDialog.open();
}
function renderPageView(){
  if(state.view==='profile')renderProfile();
  else if(state.view==='review')openReview();
}
function creatorBadge(status){
  return {none:'<span class="status-chip role">个人用户</span>',pending:'<span class="status-chip pending">创作者审核中</span>',approved:'<span class="status-chip published">创作者</span>',rejected:'<span class="status-chip rejected">创作者申请未通过</span>'}[status||'none'];
}
function renderProfile(){
  const host=$('#page-view');if(!host)return;
  if(!state.user){host.innerHTML=`<div class="page-wrap"><button class="page-back" data-action="back-page">← 返回</button><div class="page-empty">${icon('user')}<h3>登录后查看个人资料</h3><p>使用邮箱和密码登录，管理你的昵称、密码与社交主页。</p><button class="button dark" data-action="login">登录 / 注册</button></div></div>`;return;}
  const user=state.user,creatorStatus=user.creatorStatus||'none',social=Object.entries(user.social||{}),counts={published:0,pending:0,rejected:0};
  for(const work of state.myWorks)counts[work.status||'published']++;
  const isCreator=creatorStatus==='approved'||user.role==='admin';
  // 社交主页随创作者身份变化：申请中只读展示，通过后可编辑，未申请/被驳回引导申请。
  let socialBlock;
  if(creatorStatus==='pending'){
    socialBlock=`<div class="profile-social-row"><span class="profile-label">社交主页（创作者申请材料，审核中）</span><div class="profile-social">${socialLinksHtml(Object.fromEntries(social))}</div><p class="profile-hint">通过后即可发布作品，社交主页会展示在你发布的全部作品上。</p></div>`;
  }else if(creatorStatus==='rejected'){
    socialBlock=`<div class="profile-social-row"><span class="profile-label">创作者申请未通过</span><p class="profile-hint reject">原因：${escape(user.creatorNote||'未通过审核')}</p><button class="button soft" data-action="apply-creator">修改社交主页并重新申请</button></div>`;
  }else if(isCreator){
    socialBlock=`<div class="profile-social-row"><span class="profile-label">社交主页<span class="info-bubble" tabindex="0" role="note" aria-label="社交主页说明">i<span class="info-text">${SOCIAL_TIP}</span></span></span><div class="profile-social">${social.length?socialLinksHtml(Object.fromEntries(social)):'<span class="profile-empty">未设置</span>'}<button class="icon-button profile-social-edit" data-action="edit-social" aria-label="编辑社交主页">${icon('edit')}</button></div></div>`;
  }else{
    socialBlock=`<div class="profile-social-row"><span class="profile-label">创作者认证</span><p class="profile-hint">发布作品需要创作者身份。填写社交主页提交申请，管理员审核通过后即可发布，主页链接会展示在你发布的全部作品上。</p><button class="button dark" data-action="apply-creator">${icon('edit')}申请成为创作者</button></div>`;
  }
  host.innerHTML=`<div class="page-wrap">
    <button class="page-back" data-action="back-page">← 返回</button>
    <div class="page-heading"><h2>个人资料</h2></div>
    <section class="card-block profile-card">
      <div class="profile-head">
        ${avatarHtml(user,56)}
        <div class="profile-id">
          <strong class="profile-name">${escape(user.nickname)}</strong>
          <div class="profile-badges">${creatorBadge(creatorStatus)}${user.role==='admin'?'<span class="status-chip admin-chip">管理员</span>':''}</div>
          <span class="profile-label">邮箱</span>
          <span class="profile-email">${escape(user.email)}</span>
        </div>
        <div class="profile-actions"><button class="button white profile-edit" data-action="edit-nickname">${icon('edit')}自定义昵称</button><button class="button white" data-action="change-password">修改密码</button></div>
      </div>
      ${socialBlock}
    </section>
    <section class="card-block profile-works">
      <div class="profile-works-head"><h3>我的作品</h3><button class="button soft" data-view="creations">查看全部</button></div>
      <p class="profile-works-copy">新发布或修改的作品会先进入审核，通过后公开展示，头像会链接到这里的主页。</p>
      <div class="profile-status-row">
        <span class="status-chip published">已发布 ${counts.published}</span>
        <span class="status-chip pending">待审核 ${counts.pending}</span>
        <span class="status-chip rejected">未通过 ${counts.rejected}</span>
        ${user.role==='admin'?`<button class="status-chip admin" data-view="review">${icon('check')}审核管理</button>`:''}
      </div>
    </section>
  </div>`;
  decorate(host);
}
function openPassword(){
  const dialog=$('#password');
  if(dialog.open)return;
  let challenge=null,busy=false,timer=null;
  const email=state.user?.email||'';
  dialog.innerHTML=`<form id="password-form" class="mini-form"><button type="button" class="icon-button close" data-close="password" aria-label="关闭"><span data-icon="x"></span></button><p class="eyebrow">ACCOUNT SECURITY</p><h2 id="password-title">修改密码</h2><p class="auth-intro">验证码会发送到 ${escape(email)}。验证成功后即可设置新的登录密码。</p><div class="password-code-row"><label class="field">邮箱验证码<input id="password-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="输入 6 位数字"></label><button type="button" class="button soft" id="password-send">获取验证码</button></div><p id="password-demo" class="password-demo" hidden></p><label class="field">新密码<input id="password-new" type="password" maxlength="64" autocomplete="new-password" placeholder="至少 8 位，包含字母和数字"></label><label class="field">确认新密码<input id="password-confirm" type="password" maxlength="64" autocomplete="new-password" placeholder="再次输入新密码"></label><p class="password-hint">密码需为 8-64 个字符，并同时包含字母和数字。修改后请使用新密码登录。</p><p id="password-error" class="auth-error" role="alert" hidden></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="password">取消</button><button type="submit" class="button dark">修改密码</button></div></form>`;
  decorate(dialog);
  const error=$('#password-error');
  const showError=message=>{error.textContent=message;error.hidden=false;};
  const updateCountdown=()=>{
    const button=$('#password-send');
    if(!button)return;
    if(!challenge){button.disabled=busy;button.textContent='获取验证码';return;}
    const seconds=Math.max(0,Math.ceil((challenge.retryAt-Date.now())/1000));
    button.disabled=busy||seconds>0;
    button.textContent=seconds?`${seconds} 秒后重新获取`:'重新获取验证码';
  };
  const setBusy=value=>{
    busy=value;
    dialog.querySelectorAll('button,input').forEach(control=>{control.disabled=value;});
    updateCountdown();
  };
  const sendCode=async()=>{
    error.hidden=true;
    setBusy(true);
    $('#password-send').textContent='正在发送…';
    try{
      const data=await requestJson('/api/auth/password/code',{method:'POST'});
      challenge=data;
      const demo=$('#password-demo');
      if(data.delivery==='demo'&&data.devCode){demo.innerHTML=`本地演示，未发送邮件。验证码：<strong>${escape(data.devCode)}</strong>`;demo.hidden=false;}
      toast('验证码已发送');
    }catch(err){
      showError(err.message);
    }finally{
      setBusy(false);
      updateCountdown();
    }
  };
  $('#password-send').addEventListener('click',sendCode);
  $('#password-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(busy)return;
    error.hidden=true;
    const code=$('#password-code').value.trim(),password=$('#password-new').value,confirm=$('#password-confirm').value;
    if(!challenge){showError('请先获取邮箱验证码。');$('#password-code').focus();return;}
    if(!/^\d{6}$/.test(code)){showError('请输入 6 位数字验证码。');$('#password-code').focus();return;}
    if(password.length<8||password.length>64){showError('密码需为 8-64 个字符。');$('#password-new').focus();return;}
    if(!/[A-Za-z]/.test(password)||!/\d/.test(password)){showError('密码需同时包含字母和数字。');$('#password-new').focus();return;}
    if(password!==confirm){showError('两次输入的新密码不一致。');$('#password-confirm').focus();return;}
    setBusy(true);
    try{
      const data=await requestJson('/api/user/password',{method:'POST',body:{code,challengeId:challenge.challengeId,password}});
      dialog.close();
      applySession(data.user);
      toast('密码已修改，请使用新密码登录');
    }catch(err){
      setBusy(false);
      showError(err.message);
    }
  });
  dialog.onclose=()=>{clearInterval(timer);dialog.replaceChildren();challenge=null;busy=false;};
  dialog.showModal();
  $('#password-code').focus();
  timer=setInterval(updateCountdown,1000);
}
function openNickname(){
  $('#nickname').innerHTML=`<form id="nickname-form" class="mini-form"><button type="button" class="icon-button close" data-close="nickname" aria-label="关闭"><span data-icon="x"></span></button><p class="eyebrow">PROFILE</p><h2 id="nickname-title">自定义昵称</h2><label class="field">昵称<input id="nickname-input" maxlength="20" required value="${escape(state.user?.nickname||'')}" placeholder="展示在作品与个人主页上的名字"></label><p id="nickname-error" class="auth-error" role="alert" hidden></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="nickname">取消</button><button type="submit" class="button dark">保存</button></div></form>`;
  decorate($('#nickname'));
  if(!$('#nickname').open)$('#nickname').showModal();
  $('#nickname-input').focus();
  $('#nickname-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const nickname=$('#nickname-input').value.trim();
    try{
      const data=await requestJson('/api/user/profile',{method:'PATCH',body:{nickname}});
      $('#nickname').close();applySession(data.user);toast('昵称已更新');renderPageView();
    }catch(error){const element=$('#nickname-error');element.textContent=error.message;element.hidden=false;}
  });
}
function openSocial(apply=false){
  const links={...(state.user?.social||{})};
  const intro=apply?`填写你的社交主页提交申请，管理员审核通过后即可发布作品，主页链接会展示在你发布的全部作品上。`+SOCIAL_TIP:SOCIAL_TIP;
  $('#social').innerHTML=`<div class="social-layout"><button class="icon-button close" data-close="social" aria-label="关闭"><span data-icon="x"></span></button><p class="eyebrow">${apply?'CREATOR APPLICATION':'SOCIAL LINKS'}</p><h2 id="social-title">${apply?'申请成为创作者':'社交主页'}</h2><p class="auth-intro">${intro}</p>
<div id="social-list" class="social-list"></div>
<div class="social-add"><label class="field">平台<select id="social-platform"></select></label><label class="field social-url-field">主页链接<input id="social-url" maxlength="300" placeholder="https://instagram.com/你的用户名"></label><button type="button" class="button soft" id="social-add">添加</button></div>
<p id="social-error" class="auth-error" role="alert" hidden></p>
<div class="mini-form-actions"><button type="button" class="button soft" data-close="social">取消</button><button type="button" class="button dark" id="social-save">${apply?'提交申请':'保存'}</button></div></div>`;
  decorate($('#social'));
  const renderList=()=>{
    $('#social-list').innerHTML=Object.entries(links).map(([key,url])=>`<div class="social-item"><strong>${escape(SOCIAL_PLATFORMS[key]||key)}</strong><span class="social-url">${escape(url)}</span><button type="button" data-social-remove="${key}" aria-label="移除${escape(SOCIAL_PLATFORMS[key]||key)}">${icon('x')}</button></div>`).join('')||'<p class="profile-empty">还没有添加社交主页链接。</p>';
    const remaining=Object.entries(SOCIAL_PLATFORMS).filter(([key])=>!links[key]);
    $('#social-platform').innerHTML=remaining.map(([key,name])=>`<option value="${key}">${name}</option>`).join('');
    $('#social-add').disabled=!remaining.length;
  };
  renderList();
  if(!$('#social').open)$('#social').showModal();
  $('#social-list').addEventListener('click',event=>{
    const button=event.target.closest('button[data-social-remove]');if(!button)return;
    delete links[button.dataset.socialRemove];renderList();
  });
  $('#social-add').addEventListener('click',()=>{
    const error=$('#social-error');error.hidden=true;
    const key=$('#social-platform').value,url=$('#social-url').value.trim();
    if(!key){error.textContent='请选择社交平台。';error.hidden=false;return;}
    if(!/^https:\/\/\S+$/.test(url)){error.textContent='请粘贴以 https:// 开头的完整主页链接。';error.hidden=false;return;}
    links[key]=url;$('#social-url').value='';renderList();
  });
  $('#social-save').addEventListener('click',async()=>{
    const error=$('#social-error');error.hidden=true;
    if(apply&&!Object.keys(links).length){error.textContent='请至少添加一条社交主页链接。';error.hidden=false;return;}
    try{
      const data=apply
        ?await requestJson('/api/user/creator-application',{method:'POST',body:{social:links}})
        :await requestJson('/api/user/profile',{method:'PATCH',body:{social:links}});
      $('#social').close();applySession(data.user);
      toast(apply?'创作者申请已提交，请等待管理员审核':'社交主页已更新，将展示在你发布的作品上');
      renderPageView();
    }catch(err){error.textContent=err.message;error.hidden=false;}
  });
}
let userCursor=null,userHistory=[],userCurrentCursor=null;
async function openUserPage(id,cursor=null){
  if(state.userViewId!==id){userHistory=[];userCursor=null;userCurrentCursor=null;}
  const seq=++pageSeq;
  state.view='user';state.userViewId=id;
  renderViewActions();
  document.body.classList.add('view-page');
  document.body.classList.remove('view-secondary');
  $('#page-view').hidden=false;
  const host=$('#page-view');
  host.innerHTML='<div class="page-wrap"><button class="page-back" data-action="back-page">← 返回</button><p class="page-loading">正在加载主页…</p></div>';
  document.querySelectorAll('[data-view]').forEach(button=>{button.classList.toggle('active',false);button.removeAttribute('aria-current');});
  try{
    const params=new URLSearchParams({limit:'36',cards:'1'});if(cursor)params.set('cursor',cursor);
    const data=await requestJson(`/api/users/${encodeURIComponent(id)}/works?${params}`);
    if(seq!==pageSeq||state.view!=='user')return;
    state.viewUser=data.user;state.userWorks=Array.isArray(data.works)?data.works:[];
    userCursor=data.nextCursor;userCurrentCursor=cursor;state.userWorksTotal=data.total;
  }catch{
    if(seq!==pageSeq||state.view!=='user')return;
    state.viewUser=null;state.userWorks=[];
  }
  renderUserPage();
}
function renderUserPage(){
  const host=$('#page-view'),user=state.viewUser;
  if(!user){host.innerHTML=`<div class="page-wrap"><button class="page-back" data-action="back-page">← 返回</button><div class="page-empty">${icon('user')}<h3>没有找到这位创作者</h3><p>主页可能已经不存在。</p><button class="button dark" data-action="back-page">回到灵感库</button></div></div>`;return;}
  const social=Object.entries(user.social||{});
  host.innerHTML=`<div class="page-wrap">
    <button class="page-back" data-action="back-page">← 返回</button>
    <section class="card-block user-hero">
      ${avatarHtml(user,64)}
      <div class="user-hero-info">
        <div class="user-hero-name-row"><strong>${escape(user.nickname)}</strong>${user.creator?'<span class="status-chip published">创作者</span>':''}</div>
        <span>${new Date(user.createdAt).toLocaleDateString('zh-CN')} 加入</span>
        ${social.length?`<div class="user-hero-social">${socialLinksHtml(Object.fromEntries(social))}</div>`:''}
      </div>
    </section>
    <div class="user-works-head"><h3>发布的作品</h3><span>${state.userWorksTotal??state.userWorks.length} 件</span></div>
    ${state.userWorks.length?`<div class="cards user-cards">${state.userWorks.map(cardHtml).join('')}</div>`:'<div class="page-empty small">还没有公开展示的作品。</div>'}
  </div>`;
  host.querySelector('.page-wrap').insertAdjacentHTML('beforeend',`<div class="gallery-pager"><button class="button soft" data-action="user-prev" ${userHistory.length?'':'disabled'}>上一页</button><span>第 ${userHistory.length+1} 页</span><button class="button soft" data-action="user-next" ${userCursor?'':'disabled'}>下一页</button></div>`);
  decorate(host);
  host.querySelectorAll('.card-open img').forEach(img=>img.addEventListener('error',()=>img.closest('.card-visual')?.classList.add('image-failed'),{once:true}));
}
async function openReview(){
  // 深链接刷新时会话尚未加载完成：等待后仍不在审核页（用户已离开）就不渲染，避免误跳转。
  if(!state.user&&sessionPromise){await sessionPromise.catch(()=>{});if(state.view!=='review')return;}
  if(state.user?.role!=='admin'){go('explore');return;}
  const seq=++pageSeq;
  const host=$('#page-view');
  host.innerHTML='<div class="page-wrap"><button class="page-back" data-action="back-page">← 返回</button><div class="page-heading"><h2>审核管理</h2></div><p class="page-loading">正在加载待审核内容…</p></div>';
  try{
    const [pending,rejected]=await Promise.all([requestJson('/api/admin/works?status=pending&limit=36&cards=1'),requestJson('/api/admin/works?status=rejected&limit=10&cards=1')]);
    if(seq!==pageSeq||state.view!=='review')return;
    state.reviewPending=pending.works||[];state.reviewRejected=rejected.works||[];
    state.reviewTotal=pending.total;
  }catch(error){
    if(seq!==pageSeq||state.view!=='review')return;
    state.reviewPending=[];state.reviewRejected=[];state.creatorPending=null;
    host.innerHTML=`<div class="page-wrap"><button class="page-back" data-action="back-page">← 返回</button><div class="page-empty">${icon('x')}<h3>无法加载审核列表</h3><p>${escape(error.message)}</p></div></div>`;
    return;
  }
  try{
    const creators=await requestJson('/api/admin/creators?status=pending');
    if(seq!==pageSeq||state.view!=='review')return;
    state.creatorPending=creators.users||[];
  }catch{
    if(seq!==pageSeq||state.view!=='review')return;
    // 加载失败不能伪装成“暂无申请”，否则管理员可能据此漏审。
    state.creatorPending=null;
  }
  renderReview();
}
function creatorItem(u){
  const time=u.creatorRequestedAt?new Date(u.creatorRequestedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  const social=socialLinksHtml(u.social);
  return `<div class="review-item">${avatarHtml(u,44)}<div class="review-info"><strong>${escape(u.nickname)}</strong><span>${escape(u.email)} · ${time} 申请</span>${social?`<div class="review-social">${social}</div>`:'<span class="review-note">未提供社交主页链接</span>'}</div><div class="review-actions"><button class="button soft" data-creator-approve="${escape(u.id)}">${icon('check')}通过</button><button class="button soft" data-creator-reject="${escape(u.id)}">驳回</button></div></div>`;
}
function renderReview(){
  const host=$('#page-view');
  const creatorSection=state.creatorPending===null
    ?'<p class="profile-empty">创作者申请加载失败。<button type="button" class="auth-link" data-action="reload-review">重新加载</button></p>'
    :state.creatorPending.length?`<div class="review-list">${state.creatorPending.map(creatorItem).join('')}</div>`:'<p class="profile-empty">暂无创作者申请。</p>';
  host.innerHTML=`<div class="page-wrap">
    <button class="page-back" data-action="back-page">← 返回</button>
    <div class="page-heading"><h2>审核管理</h2><span>${state.creatorPending?.length??0} 项创作者申请 · ${state.reviewTotal??state.reviewPending.length} 件作品待处理</span></div>
    <section class="card-block"><h3 class="block-title">创作者申请</h3>${creatorSection}</section>
    <section class="card-block"><h3 class="block-title">待审核作品</h3>${state.reviewPending.length?`<div class="review-list">${state.reviewPending.map(reviewItem).join('')}</div>`:'<p class="profile-empty">所有作品都已处理完毕。</p>'}</section>
    <section class="card-block"><h3 class="block-title">最近驳回作品</h3>${state.reviewRejected.length?`<div class="review-list">${state.reviewRejected.slice(0,10).map(reviewItem).join('')}</div>`:'<p class="profile-empty">暂无驳回记录。</p>'}</section>
  </div>`;
  decorate(host);
}
async function creatorDecide(id,decision,note){
  const epoch=sessionEpoch;
  try{
    const data=await requestJson(`/api/admin/creators/${id}/review`,{method:'POST',body:{decision,note}});
    if(epoch!==sessionEpoch||state.user?.role!=='admin')return;
    state.creatorPending=state.creatorPending.filter(u=>u.id!==id);
    if(state.user?.id===id)applySession(data.user);
    toast(decision==='approve'?'已通过创作者申请，对方现在可以发布作品':'已驳回创作者申请');
    if(state.view==='review')openReview();
  }catch(error){toast(error.message||'审核操作失败，请重试。');}
}
function reviewItem(p){
  const time=new Date(p.created).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  return `<div class="review-item"><button class="review-thumb" data-open="${escape(p.id)}" aria-label="预览${escape(p.title)}">${cardMedia(p)}</button><div class="review-info"><strong>${escape(p.title)}</strong><span>${escape(p.author||'佚名')} · ${time} 提交</span>${p.status==='rejected'&&p.reviewNote?`<span class="review-note">原因：${escape(p.reviewNote)}</span>`:''}</div>${p.status==='pending'?`<div class="review-actions"><button class="button soft" data-review-approve="${escape(p.id)}">${icon('check')}通过</button><button class="button soft" data-review-reject="${escape(p.id)}">驳回</button></div>`:''}</div>`;
}
async function reviewDecide(id,decision,note){
  const epoch=sessionEpoch,item=state.reviewPending.find(p=>p.id===id);
  if(!item||state.user?.role!=='admin')return;
  try{
    const {work}=await requestJson(`/api/admin/works/${id}/review`,{method:'POST',body:{decision,note,expectedRevision:item.revision}});
    if(epoch!==sessionEpoch||state.user?.role!=='admin')return;
    state.reviewPending=state.reviewPending.filter(p=>p.id!==id);
    if(decision==='approve'&&item){
      state.reviewRejected=state.reviewRejected.filter(p=>p.id!==id);
      state.works=[work,...state.works.filter(p=>p.id!==id)];
      state.myWorks=state.myWorks.map(p=>p.id===id?work:p);
      toast('已通过，作品现在展示在灵感库');
    }else{
      const mine=state.myWorks.find(p=>p.id===id);
      if(mine)state.myWorks=state.myWorks.map(p=>p.id===id?work:p);
      toast('已驳回该作品，作者修改后可重新提交');
    }
    render();
    if(state.view==='review')openReview();
  }catch(error){if(epoch!==sessionEpoch)return;toast(error.message||'审核操作失败，请重试。');if(state.view==='review')openReview();}
}
function openReject(id,type='work'){
  const isCreator=type==='creator';
  $('#reject').innerHTML=`<form id="reject-form" class="mini-form"><button type="button" class="icon-button close" data-close="reject" aria-label="关闭"><span data-icon="x"></span></button><p class="eyebrow">REVIEW</p><h2 id="reject-title">${isCreator?'驳回创作者申请':'驳回作品'}</h2><label class="field">未通过原因（对方可见）<textarea id="reject-note" maxlength="200" required placeholder="${isCreator?'例如：社交主页链接无效、资料不完整等':'例如：附件与提示词无关、包含多余水印等'}"></textarea></label><p id="reject-error" class="auth-error" role="alert" hidden></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="reject">取消</button><button type="submit" class="button dark">确认驳回</button></div></form>`;
  decorate($('#reject'));
  if(!$('#reject').open)$('#reject').showModal();
  $('#reject-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const note=$('#reject-note').value.trim();
    if(!note){const element=$('#reject-error');element.textContent='请填写未通过原因。';element.hidden=false;return;}
    $('#reject').close();
    if(isCreator)creatorDecide(id,'reject',note);else reviewDecide(id,'reject',note);
  });
}
function cardMedia(p){
  const cover=p.media?.[0];
  if(cover?.thumbnailUrl)return `<img src="${escape(cover.thumbnailUrl)}" srcset="${escape(cover.thumbnailSmall)} 320w, ${escape(cover.thumbnailUrl)} 640w, ${escape(cover.thumbnailLarge)} 1280w" sizes="(max-width:580px) 48vw, (max-width:1000px) 30vw, 24vw" alt="${escape(p.title)}作品封面" loading="lazy" decoding="async">`;
  if(cover)return cover.type==='video'?`<div class="draft-text-preview"><p>${icon('video')}</p><small>点击查看视频</small></div>`:'<img src="'+escape(cover.url)+'" alt="'+escape(p.title)+'作品封面" loading="lazy" decoding="async">';
  if(p.custom){
    const preview=draftPreview(p,allPrompts().concat(state.myWorks));
    return preview?`<img src="${escape(preview.url)}" alt="${escape(p.title)}的${preview.label}" loading="lazy" decoding="async">`:`<div class="draft-text-preview"><p>${escape(p.prompt)}</p><small>文字草稿 · 暂无图片</small></div>`;
  }
  return '<img src="'+escape(p.image)+'" alt="'+escape(p.subtitle)+'，视觉参考图" loading="lazy" decoding="async">';
}
function draftDetailMedia(p){
  const preview=draftPreview(p,allPrompts().concat(state.myWorks));
  return preview?`<img class="detail-image" src="${escape(preview.url)}" alt="${escape(p.title)}的${preview.label}">`:`<div class="draft-no-image">${icon('edit')}<p>文字草稿</p><small>尚未关联图片</small></div>`;
}
function attachmentGallery(p){
  const multi=p.media.length>1;
  return '<div class="gallery-stage"></div>'
    +(multi?'<button class="gallery-arrow gallery-arrow-prev" data-action="media-prev" aria-label="上一个附件">‹</button><button class="gallery-arrow gallery-arrow-next" data-action="media-next" aria-label="下一个附件">›</button><div class="gallery-thumbnails">'+p.media.map((m,i)=>'<button class="gallery-thumb" data-media-index="'+i+'" aria-label="查看第 '+(i+1)+' 个'+(m.type==='video'?'视频':'图片')+'">'+(m.type==='video'?(m.thumbnailSmall?'<img src="'+escape(m.thumbnailSmall)+'" alt="">':'<span>视频</span>'):'<img src="'+escape(m.thumbnailSmall||m.url)+'" alt="">')+'</button>').join('')+'</div>':'')
    +'<p class="gallery-caption">上传作品 · '+p.media.length+' 个附件</p>';
}
function showMedia(index){
  if(!currentPrompt?.media?.length)return;const media=currentPrompt.media;activeMedia=(index+media.length)%media.length;
  const item=media[activeMedia],stage=$('#detail .gallery-stage');if(!stage)return;
  stage.querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});
  stage.innerHTML=item.type==='video'?'<video controls playsinline preload="metadata" src="'+escape(item.url)+'" aria-label="'+escape(item.name)+'"></video>':'<img src="'+escape(item.url)+'" alt="'+escape(currentPrompt.title)+'，第 '+(activeMedia+1)+' 张图片">';
  const position=$('#media-position');if(position)position.textContent=(activeMedia+1)+' / '+media.length;
  $('#detail').querySelectorAll('[data-media-index]').forEach(button=>{const active=Number(button.dataset.mediaIndex)===activeMedia;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  const download=$('#detail .detail-download');if(download)download.href=item.url;
  const video=stage.querySelector('video');if(video)video.addEventListener('error',()=>{stage.insertAdjacentHTML('beforeend','<p class="video-problem">此浏览器无法播放该视频编码。<a href="'+escape(item.url)+'" download>下载原文件</a>，或上传 H.264 MP4 / WebM 版本。</p>');},{once:true});
}

function toast(message) { const element = $('#toast'); element.textContent=message; element.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>element.classList.remove('show'),3000); }
function decorate(root=document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML=icon(el.dataset.icon); }); }
function results() {
  let items;
  const matches=p=>(state.type==='all'||(p.mediaTypes?p.mediaTypes.includes(state.type):p.media?.length?p.media.some(m=>m.type===state.type):p.type===state.type))&&(state.category==='全部灵感'||p.category===state.category||p.tags.includes(state.category))&&(state.model==='all'||p.model===state.model);
  if(state.view==='creations'){
    // 我的作品：本人全部审核状态 + 无归属的历史上传作品；筛选条件与探索视图共用。
    const works=state.user?[...state.myWorks,...state.works.filter(p=>p.uploaded&&!p.authorId)]:[];
    items=[...new Map(works.map(p=>[p.id,p])).values()].filter(p=>matches(p)&&(state.workStatus==='all'?p.status!=='withdrawn':p.status===state.workStatus));
  }else if(state.view==='drafts'){
    items=studioItems({tab:state.studioTab,drafts:state.drafts,generations:state.generations,works:state.myWorks,userId:state.user?.id}).filter(matches);
  }else{
    items=allPrompts().filter(p=>(state.view !== 'collections' || state.saved.has(p.id)) && (state.view !== 'recent' || p.uploaded) && matches(p));
  }
  if(state.query.trim()) { const words=state.query.toLowerCase().trim().split(/\s+/); items=items.filter(p=>p.cardOnly||words.every(word=>[p.title,p.subtitle,p.category,p.model,p.prompt,...p.tags].join(' ').toLowerCase().includes(word))); }
  if(['recent','creations','drafts'].includes(state.view)) items.sort((a,b)=>(b.updated||b.created||0)-(a.updated||a.created||0));
  else if(state.sort==='popular') items.sort((a,b)=>b.likes-a.likes);
  else if(state.sort==='newest') items.sort((a,b)=>(b.created||prompts.indexOf(b))-(a.created||prompts.indexOf(a)));
  if(galleryCurrentCursor&&['explore','recent','collections'].includes(state.view))items=items.filter(p=>p.uploaded);
  return items;
}
function statusBadge(p){
  if(p.status==='draft')return '<span class="draft-badge">发布草稿</span>';
  if(p.status==='pending')return '<span class="draft-badge pending-badge">待审核</span>';
  if(p.status==='rejected')return `<span class="draft-badge rejected-badge" title="${escape(p.reviewNote||'未通过审核')}">未通过</span>`;
  if(p.status==='withdrawn')return `<span class="draft-badge withdrawn-badge" title="${escape(p.withdrawnNote||'已下架')}">已下架</span>`;
  return '<span class="draft-badge published-badge">已发布</span>';
}
function canManageWork(p){return !!state.user&&(p.status==='withdrawn'?p.authorId===state.user.id:!p.authorId||p.authorId===state.user.id||state.user.role==='admin');}
function canEditWork(p){return canManageWork(p)&&(p.status==='draft'||(p.status==='withdrawn'?state.view==='creations'&&state.workStatus==='withdrawn':state.user.role!=='admin'));}
function workControls(p){
  if(!p?.uploaded||!canManageWork(p))return '';
  const edit=canEditWork(p)?`<button data-work-edit="${escape(p.id)}" data-tooltip="编辑作品" aria-label="编辑${escape(p.title)}">${icon('edit')}</button>`:'';
  if(p.status==='draft'||p.status==='withdrawn')return edit+`<button data-work-delete="${escape(p.id)}" data-tooltip="删除作品" aria-label="删除${escape(p.title)}">${icon('x')}</button>`;
  return edit+`<button data-work-withdraw="${escape(p.id)}" data-tooltip="下架作品" aria-label="下架${escape(p.title)}">${icon('withdraw')}</button>`;
}
function cardHtml(p){
  const draftClass=p.status==='draft'?' publishing-draft':p.custom&&!p.uploaded?' draft-card':'';
  const badge=p.custom?(p.uploaded?statusBadge(p):'<span class="draft-badge">草稿</span>'):`<span class="card-likes" title="示例热度">${icon('heart')}${p.likes+(state.saved.has(p.id)?1:0)}</span>`;
  return `<article class="card${draftClass}${p.uploaded?' own-work':''}" data-id="${escape(p.id)}"><div class="card-visual" style="--card-color:${/^#[0-9a-f]{6}$/i.test(p.color)?p.color:'#a6b3c5'}"><button class="card-open" data-open="${escape(p.id)}" aria-label="查看${escape(p.title)}提示词">${cardMedia(p)}</button><span class="card-tag">${p.generated?'生成记录':p.status==='withdrawn'?'已下架':p.uploaded?(p.media?.some(m=>m.type==='video')?icon('video')+' 视频作品':'上传作品'):p.type==='video'?icon('video')+' 视频分镜':p.custom?'我的创作':escape(p.category)}</span>${p.type==='video'&&(!p.custom||p.media?.some(media=>media.type==='video'))?`<span class="play-circle">${icon('play')}</span>`:''}<span class="card-model"><span class="model-dot"></span>${escape(p.model)}</span>${p.media?.length?`<span class="media-count">${p.mediaCount||p.media.length} 个附件</span>`:p.duration?`<span class="card-duration">${escape(p.duration)}</span>`:''}</div><div class="card-meta"><div class="card-title-row"><h3 class="card-title"><button data-open="${escape(p.id)}">${escape(p.title)}</button></h3>${badge}</div><p class="card-subtitle">${escape(p.subtitle)}</p></div></article>`;
}
function render() {
  refreshGallery();
  const focused=document.activeElement;
  const focusKey=['category','save','apply','open'].find(key=>focused?.dataset?.[key]);
  const focusValue=focusKey?focused.dataset[focusKey]:null;
  const items=results();
  $('.sort-tabs[data-gallery-sort]').hidden=['creations','drafts'].includes(state.view);
  $('.work-status-tabs').hidden=state.view!=='creations';
  $('.studio-tabs').hidden=state.view!=='drafts';
  document.querySelectorAll('[data-studio-tab]').forEach(button=>{const active=button.dataset.studioTab===state.studioTab;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  $('#studio-status').hidden=!state.generationError||state.view!=='drafts'||state.studioTab==='drafts';
  $('.category-list').innerHTML=categories.map(cat=>`<button data-category="${escape(cat)}" class="${cat===state.category?'active':''}" aria-pressed="${cat===state.category}">${escape(cat)}</button>`).join('');
  $('#cards').innerHTML=items.map(cardHtml).join('');
  let pager=$('#gallery-pager');if(!pager){pager=document.createElement('div');pager.id='gallery-pager';pager.className='gallery-pager';$('#cards').after(pager);}
  pager.hidden=!galleryEndpoint()||(state.view==='creations'&&!state.user);pager.innerHTML=!pager.hidden?`<button class="button soft" data-action="gallery-prev" ${!galleryHistory.length||galleryLoading?'disabled':''}>上一页</button><span>${galleryLoading?'正在加载…':`第 ${galleryHistory.length+1} 页 · ${galleryTotal} 件上传作品`}</span><button class="button soft" data-action="gallery-next" ${!galleryCursor||galleryLoading?'disabled':''}>下一页</button>`:'';
  $('#result-count').textContent=state.view==='drafts'?`${items.length} ${ {drafts:'份草稿',generations:'条生成记录',submissions:'件投稿'}[state.studioTab]}`:`${items.length} 个灵感`;
  const savedCount=allPrompts().filter(p=>state.saved.has(p.id)).length;$('#saved-count').textContent=savedCount?savedCount:'';
  $('#empty').hidden=items.length>0;
  if(!items.length){$('#empty h3').textContent=state.view==='collections'&&!state.query?'把喜欢的灵感，留在这里':state.view==='creations'?'展示你的第一件作品':state.view==='recent'?'还没有上传过作品':state.view==='drafts'?'从你的第一份提示词开始':'还没有找到这份灵感';$('#empty p').textContent=state.view==='collections'?'点击作品上的收藏按钮，留下喜欢的灵感。':state.view==='creations'?(state.user?.accountType==='creator'?'点击右上角「发布作品」，上传已经完成的图片或视频。':state.user?'可在个人资料中申请创作者，通过后发布自己的作品。':'登录后查看自己的作品，创作者账号还可以发布作品。'):state.view==='recent'?'发布图片或视频后，最新上传的内容会出现在这里。':state.view==='drafts'?'点击右上角「开始创作」，编辑提示词并保存草稿。':'换一个关键词，或清除筛选重新探索。';}
  document.querySelectorAll('[data-type]').forEach(b=>{b.classList.toggle('selected',b.dataset.type===state.type);b.setAttribute('aria-pressed',String(b.dataset.type===state.type));});
  if(!items.length&&state.view==='creations'&&state.workStatus!=='all'){
    $('#empty h3').textContent=state.workStatus==='withdrawn'?'暂无下架作品':'暂无'+workStatusLabels[state.workStatus]+'作品';
    $('#empty p').textContent='再次点击已选状态取消筛选，或清除筛选查看其他作品。';
  }
  if(!items.length&&state.view==='drafts'){
    const filtered=state.query.trim()||state.model!=='all'||state.type!=='all'||state.category!=='全部灵感';
    const empty={drafts:['从你的第一份提示词开始','点击右上角「开始创作」，编辑提示词并保存草稿。'],generations:[state.user?'还没有生成记录':'登录后查看生成记录',state.user?'在创作台生成第一张图片，完成后会保存在这里。':'生成记录仅当前账号可见。'],submissions:[state.user?'还没有投稿作品':'登录后查看我的投稿',state.user?'在创作台生成图片并投稿，审核通过后会显示在这里。':'这里只展示当前账号在创作台生成并发布到灵感库的图片作品。']}[state.studioTab];
    $('#empty h3').textContent=filtered?'没有符合筛选的'+studioTabs[state.studioTab]:empty[0];$('#empty p').textContent=filtered?'清除筛选，查看当前分类的全部内容。':empty[1];
  }
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===state.view); if(b.dataset.view===state.view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  $('#cards').querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.closest('.card-visual').classList.add('image-failed'),{once:true}));
  $('#cards').querySelectorAll('.card').forEach((card,index)=>{
    card.draggable=false;
    card.querySelector('.card-open').draggable=false;
    card.querySelectorAll('img,video').forEach(media=>media.draggable=false);
    card.style.setProperty('--tile-ratio', '3 / 4');
    const p=findWork(card.dataset.id);
    if(p?.type==='video')card.style.setProperty('--tile-ratio','16 / 9');
    const image=card.querySelector('.card-open img');if(image){const fit=()=>{if(image.naturalWidth&&image.naturalHeight)card.style.setProperty('--tile-ratio',String(Math.max(.5,Math.min(1.6,image.naturalWidth/image.naturalHeight))));};image.addEventListener('load',fit,{once:true});if(image.complete)fit();}
    const author=p?.authorProfile||(p?.authorId&&p.authorId===state.user?.id?state.user:{id:p?.authorId||p?.id,nickname:p?.author||(p?.custom?'我':'Luma Studio')});
    const social=creatorSocial(author.social);
    const authorName=escape(author.nickname);
    const authorNote=social?.handle||(p?.generated?'生成记录':p?.status==='draft'?'发布草稿':p?.custom&&!p.uploaded?'创作草稿':p?.uploaded?social?.name||'':p?.category);
    const authorInfo=`${avatarHtml(author,30)}<span class="card-author-copy"><strong>${authorName}</strong>${authorNote?`<small title="${escape(authorNote)}">${escape(authorNote)}</small>`:''}</span>`;
    const authorControl=p?.authorId?`<button class="card-author" data-author="${escape(p.authorId)}" data-tooltip="查看作者" aria-label="查看${authorName}的主页">${authorInfo}</button>`:`<span class="card-author">${authorInfo}</span>`;
    const saved=state.saved.has(p.id),saveLabel=saved?'取消收藏':'收藏作品';
    const socialControl=social?`<a class="card-social" href="${escape(social.url)}" target="_blank" rel="noopener noreferrer" data-tooltip="在 ${social.name} 上查看" aria-label="在 ${social.name} 上查看${authorName}的主页">${social.key==='x'?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h4l12 18h-4zM20 3 4 21"/></svg>':`<span class="card-platform">${escape(social.name)}</span>${icon('arrow-up-right')}`}</a>`:'';
    const management=p?.generated?`<button data-publish-generation="${escape(p.id)}" data-tooltip="投稿到灵感库" aria-label="投稿${escape(p.title)}到灵感库">${icon('arrow-up-right')}</button><button data-generation-delete="${escape(p.id)}" data-tooltip="删除生成记录" aria-label="删除${escape(p.title)}">${icon('x')}</button>`:p?.uploaded?workControls(p):p?.custom?`<button data-creative-edit="${escape(p.id)}" data-tooltip="编辑草稿" aria-label="编辑${escape(p.title)}">${icon('edit')}</button><button data-creative-delete="${escape(p.id)}" data-tooltip="删除草稿" aria-label="移除${escape(p.title)}">${icon('x')}</button>`:'';
    card.insertAdjacentHTML('beforeend',`<div class="card-quick-actions">${authorControl}<div class="card-action-row"><button class="card-use" data-apply="${escape(p.id)}" data-tooltip="使用创意" aria-label="使用创意">${icon('sparkles')}使用创意</button><div class="card-controls"><button class="card-like ${saved?'saved':''}" data-save="${escape(p.id)}" data-tooltip="${saveLabel}" aria-label="${saved?'取消收藏':'收藏'}${escape(p.title)}" aria-pressed="${saved}">${icon('heart')}<span>${Number(p.likes||0)+(saved?1:0)}</span></button>${socialControl}${management}</div></div></div>`);
  });
  $('#cards').querySelectorAll('.card').forEach(card=>{
    const work=findWork(card.dataset.id);if(work?.generated)card.querySelector('.card-like')?.remove();
    if(work?.status==='withdrawn'&&work.withdrawnNote){
      card.querySelector('.card-visual').append(card.querySelector('.card-quick-actions'));
      card.insertAdjacentHTML('beforeend',`<p class="withdrawn-note">下架原因：${escape(work.withdrawnNote)}</p>`);
    }
  });
  document.querySelectorAll('[data-model]').forEach(button=>{const active=button.dataset.model===state.model;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll('[data-sort]').forEach(button=>{const active=button.dataset.sort===state.sort;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  document.querySelectorAll('[data-work-status]').forEach(button=>{const active=button.dataset.workStatus===state.workStatus;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  const filters=[state.view==='creations'&&state.workStatus!=='all'?workStatusLabels[state.workStatus]:'',state.category!=='全部灵感'?state.category:'',state.model!=='all'?state.model:'',state.query.trim()?`“${state.query.trim()}”`:'',state.type!=='all'?(state.type==='image'?'图片':'视频'):''].filter(Boolean);
  $('.filter-summary').hidden=!filters.length;$('#filter-copy').textContent=filters.join(' · ');
  if(focusKey&&!focused.isConnected){const attr=focusKey.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());document.querySelector(`[data-${attr}="${CSS.escape(focusValue)}"]`)?.focus({preventScroll:true});}
}
function setView(view) {
  state.view=['explore','collections','recent','creations','drafts','profile','review'].includes(view)?view:'explore';
  renderViewActions();
  const isPage=['profile','review'].includes(state.view);
  document.body.classList.toggle('view-secondary',state.view!=='explore');
  document.body.classList.toggle('view-page',isPage);
  $('#page-view').hidden=!isPage;
  const copy={explore:['发现灵感，<span>即刻开始。</span>','看见喜欢的画面，让它成为你的创作起点。','灵感画廊'],collections:['喜欢的，<span>都在这里。</span>','收藏触动你的画面，也留住属于自己的创意。','我的收藏'],recent:['新鲜灵感，<span>正在更新。</span>','最新上传的图片与视频，按时间倒序排列。','最近更新'],creations:['你的想法，<span>你的作品。</span>','管理发布草稿、审核状态、已发布与下架作品。','我的作品'],drafts:['创作，从<span>一个想法开始。</span>','打磨提示词、整理参考图，在这里开始创作和管理草稿。','创作台'],profile:['你的空间，<span>由此开始。</span>','管理昵称、社交主页与作品审核状态。','个人资料'],review:['作品审核，<span>一目了然。</span>','通过或驳回用户提交的上传作品。','审核管理']}[state.view];
  $('#page-title').innerHTML=copy[0];$('.intro-copy').textContent=copy[1];$('#gallery-title').textContent=copy[2];
  state.query='';state.category='全部灵感';state.type='all';state.model='all';state.workStatus='all';$('#search').value='';
  render();
  if(isPage)renderPageView();
}
// 页面跳转统一入口：hash 变化交给 hashchange→route 渲染一次；hash 已相同时直接 setView，避免双渲染/重复请求。
function go(view){if(location.hash==='#'+view)setView(view);else location.hash='#'+view;}
function toggleSave(id) {
  const next=new Set(state.saved),saved=!next.has(id);if(saved)next.add(id);else next.delete(id);
  if(!write('saved',[...next]))return;state.saved=next;
  document.querySelectorAll('[data-save]').forEach(button=>{
    if(button.dataset.save!==id)return;
    const work=findWork(id);button.classList.toggle('saved',saved);button.setAttribute('aria-pressed',String(saved));
    button.setAttribute('aria-label',(saved?'取消收藏':'收藏')+(work?.title||''));button.dataset.tooltip=saved?'取消收藏':'收藏作品';
    const count=button.querySelector('span');if(count)count.textContent=Number(work?.likes||0)+(saved?1:0);
  });
  $('#saved-count').textContent=state.saved.size||'';
  if(state.view==='collections'){galleryKey='';render();}
  if($('#detail').open&&currentPrompt?.id===id)updateDetailSave();toast(saved?'已收藏，在「我的收藏」中查看':'已取消收藏');
}
function updateDetailSave(){const b=$('#detail [data-detail-save]');if(!b)return;const saved=state.saved.has(currentPrompt.id);b.innerHTML=icon('heart')+(Number(currentPrompt.likes||0)+(saved?1:0));b.classList.toggle('saved',saved);b.setAttribute('aria-pressed',String(saved));b.setAttribute('aria-label',saved?'取消收藏作品':'收藏作品');}
let detailReturnHash='explore';
function getPromptReference(p){
  if(!p)return null;const media=p.media?.[activeMedia]?.type==='image'?p.media[activeMedia]:p.media?.find(m=>m.type==='image');
  const url=media?.url||(!p.custom?p.image:null);return url?{url,name:p.title,sourceId:p.id}:null;
}
function relatedPrompts(p){return allPrompts().filter(item=>item.id!==p.id&&(item.image||item.media?.length)).map(item=>({item,score:(item.category===p.category?4:0)+(item.model===p.model?1:0)+item.tags.filter(tag=>p.tags.includes(tag)).length})).sort((a,b)=>b.score-a.score).slice(0,8).map(({item})=>item);}
async function openPrompt(id){
  const seq=++detailSeq,epoch=sessionEpoch;
  let p=findWork(id);
  if(/^work-[0-9a-f-]{36}$/.test(id)){
    if(sessionPromise)await sessionPromise.catch(()=>{});
    try{p=(await requestJson('/api/works/'+id)).work;}
    catch(error){if(seq===detailSeq&&epoch===sessionEpoch)toast(error.message||'作品不存在或无权查看。');return;}
  }else if(!p&&sessionPromise){await sessionPromise.catch(()=>{});p=findWork(id);}
  if(!p||seq!==detailSeq||epoch!==sessionEpoch)return;currentPrompt=p;
  activeMedia=0;if(!location.hash.startsWith('#prompt/'))detailReturnHash=state.view;
  const download=p.media?.[0]?.url||(!p.custom?p.image:null);
  const attribution=p.generated?'创作台生成记录 · 仅当前账号可见':p.uploaded?(p.status==='draft'?'发布草稿 · 仅自己可见':p.status==='pending'?'审核中 · 通过后将公开展示':p.status==='rejected'?`未通过审核${p.reviewNote?'：'+escape(p.reviewNote):''} · 修改后重新提交`:'已发布作品 · 文件保存在当前网站'):p.custom?'个人提示词草稿 · 保存在当前浏览器'+(draftPreview(p,allPrompts().concat(state.myWorks))?' · 来源/参考图片预览':''):p.type==='video'?'静态分镜参考 · 非生成视频':'视觉参考照片 · 非此提示词的实测生成结果';
  const authorName=p.authorId?`<button class="detail-author-name" data-author="${escape(p.authorId)}" title="访问${escape(p.author||'创作者')}的主页">${escape(p.author||'创作者')}</button>`:escape(p.author||(p.custom?'我的作品':'Luma Studio'));
  $('#detail').innerHTML=`<div class="detail-layout"><div class="detail-viewer"><div class="viewer-tools">${p.media?.length>1?'<span class="media-position" id="media-position"></span>':''}<details class="detail-more"><summary aria-label="更多操作">${icon('more')}</summary><div><button data-action="copy-link">复制作品链接</button>${p.uploaded&&canEditWork(p)?'<button data-action="edit-work">编辑已发布作品</button>':''}</div></details>${download?'<a class="icon-button detail-download" href="'+escape(download)+'" download aria-label="下载当前图片或视频">'+icon('download')+'</a>':'<button class="icon-button" disabled aria-label="没有可下载的图片或视频">'+icon('download')+'</button>'}<button class="viewer-close" data-close="detail" aria-label="关闭详情">esc ${icon('x')}</button></div><div class="detail-image-wrap ${p.media?.length>1?'has-gallery has-multi':p.media?.length?'has-gallery':''}">${p.media?.length?attachmentGallery(p):p.custom?draftDetailMedia(p):'<img class="detail-image" src="'+escape(p.image)+'" alt="'+escape(p.title)+'的视觉参考">'}</div><div class="viewer-caption">${attribution}</div></div><div class="detail-copy"><div class="detail-author-row"><span class="author-avatar" aria-hidden="true">${escape((p.author||'我').slice(0,1))}</span><div><strong>${authorName}</strong><span>${p.generated?'生成记录':p.uploaded?'原创作品':p.custom?'创作草稿':'灵感策展'}</span></div><span class="detail-model">${icon('sparkles')}${escape(p.model)}</span></div><div class="detail-social"><button class="detail-favorite" data-detail-save aria-label="收藏作品">${icon('heart')}收藏</button><details class="share-menu"><summary aria-label="分享作品">${icon('share')}</summary><div><strong>分享作品</strong><button data-action="copy-link">${icon('copy')}复制链接</button></div></details><button data-action="copy-detail">${icon('copy')}复制 Prompt</button></div><div class="detail-scroll"><h2 id="detail-title">${escape(p.title)}</h2><div class="detail-tags"><span>${escape(p.ratio)}</span>${p.duration?'<span>'+escape(p.duration)+'</span>':''}${p.tags.slice(0,3).map(tag=>'<button data-related-category="'+escape(tag)+'">'+escape(tag)+'</button>').join('')}</div><div class="prompt-heading">提示词</div><p class="prompt-text" id="detail-prompt">${escape(p.prompt)}</p><button class="expand-prompt" data-action="expand-prompt" aria-expanded="false" aria-controls="detail-prompt">展开</button>${p.negative?'<details class="negative-prompt"><summary>负面提示词</summary><p>'+escape(p.negative)+'</p></details>':''}<section class="related-section" aria-label="更多相关内容"><h3>更多相关内容</h3><div class="related-grid">${relatedPrompts(p).map(item=>'<button data-open="'+escape(item.id)+'" aria-label="查看相关作品：'+escape(item.title)+'">'+cardMedia(item)+'<span>'+escape(item.title)+'</span></button>').join('')}</div></section></div><div class="detail-actions"><button class="button dark" data-action="edit-detail">${icon('sparkles')}使用 Prompt</button><button class="button dark" data-action="reference-detail" ${getPromptReference(p)?'':'disabled'}>${icon('image')}用作参考图</button></div>${p.uploaded&&canEditWork(p)?'<button class="detail-edit-link" data-action="edit-work">编辑已发布作品</button>':''}</div></div>`;
  if(p.generated){
    $('#detail .detail-favorite').remove();$('#detail .share-menu').remove();
    $('#detail [data-action="reference-detail"]').outerHTML=`<button class="button dark" data-publish-generation="${escape(p.id)}">${icon('arrow-up-right')}投稿到灵感库</button>`;
    $('#detail .detail-copy').insertAdjacentHTML('beforeend',`<button class="detail-edit-link" data-generation-delete="${escape(p.id)}">删除生成记录</button>`);
  }
  if(p.status==='withdrawn')$('#detail .viewer-caption').textContent='已下架'+(p.withdrawnNote?' · 下架原因：'+p.withdrawnNote:'')+' · 仅创作者本人可以操作';
  const backdrop=p.media?.find(item=>item.kind==='image'||item.type==='image')?.url||(!p.custom?p.image:null);
  if(backdrop)$('#detail .detail-viewer').style.setProperty('--preview-image',`url("${backdrop}")`);
  if(!p.generated)updateDetailSave();if(!$('#detail').open)$('#detail').showModal();if(p.media?.length)showMedia(0);
  const nextHash='prompt/'+encodeURIComponent(id);if(location.hash.slice(1)!==nextHash)location.hash=nextHash;
}
let creativeDraftId=null,creativeRefs=[],creativeSession=0,creativeEdited=false;
const imageModels=['GPT Image','Nano Banana','Midjourney','FLUX','Seedream'];
const videoModels=['Seedance','Kling','Wan','Hailuo'];
function creativeModels(type){return [...(type==='video'?videoModels:imageModels)];}
let creativePreview=null;
function getCreative(){return {title:$('#creative-title').value.trim(),prompt:$('#creative-prompt').value.trim(),negative:$('#creative-negative').value.trim(),type:$('#creative-type').value,model:$('#creative-model').selectedOptions[0]?.textContent||'',modelId:$('#creative-type').value==='image'?$('#creative-model').selectedOptions[0]?.dataset.modelId:undefined,width:Number($('#creative-width')?.value)||1024,height:Number($('#creative-height')?.value)||1024,ratio:$('#creative-ratio').value,category:$('#creative-category').value,count:Number($('#creative-count').value),previewImage:creativePreview?.url||null,previewLabel:creativePreview?.label||null,sourceId:creativePreview?.sourceId||null,references:creativeRefs.filter(ref=>!ref.file).map(({url,name,sourceId})=>({url,name,sourceId}))};}
function storeCreative(data,id=null){
  if(!data.prompt){toast('先写下一段提示词。');return null;}
  const existing=state.drafts.find(item=>item.id===id);
  const item={...existing,...data,title:data.title||'未命名创作',id:existing?.id||`custom-${crypto.randomUUID()}`,custom:true,uploaded:false,author:'我',subtitle:'个人创作草稿',tags:[data.category],likes:0,color:'#a6b3c5',created:Date.now()};
  const next=[item,...state.drafts.filter(draft=>draft.id!==item.id)];if(!write('drafts',next))return null;state.drafts=next;render();return item;
}
function persistCreative(edited=true){creativeEdited=edited;$('#creative-status').textContent=edited?'尚未保存':creativeDraftId?'已保存草稿':'新建创作';$('#creative-length').textContent=$('#creative-prompt').value.length+' / 8000';}
function renderCreativeRefs(){
  $('#creative-references').innerHTML=creativeRefs.map((ref,index)=>`<div class="creative-reference"><img src="${escape(ref.url)}" alt="参考图：${escape(ref.name)}"><button type="button" data-remove-reference="${index}" aria-label="移除第 ${index+1} 张参考图">${icon('x')}</button><span>${escape(ref.name)}</span></div>`).join('');
  $('#creative-reference-count').textContent=`${creativeRefs.length} / 4`;
}
async function openCreator(p=null,reference=null){
  if(p?.cardOnly){const epoch=sessionEpoch;try{p=(await requestJson('/api/works/'+p.id)).work;}catch(error){toast(error.message);return;}if(epoch!==sessionEpoch)return;}
  if(publishing)return;if($('#detail').open)$('#detail').close();if($('#editor').open)$('#editor').close();
  const draft=p||{};
  creativePreview=draftPreview(draft,allPrompts().concat(state.myWorks));
  creativeDraftId=p?.custom&&!p.uploaded?p.id:null;
  creativeEdited=false;creativeSession++;
  {
    // 使用 Prompt/使用创意只带入文字：不继承上一次会话遗留的参考图，草稿自身保存的参考图除外。
    creativeRefs.forEach(ref=>{if(ref.file)URL.revokeObjectURL(ref.url);});
    creativeRefs=(p?.custom&&!p.uploaded&&Array.isArray(p.references)?p.references:[]).filter(ref=>typeof ref?.url==='string'&&/^\/(assets|media)\//.test(ref.url)).slice(0,4);
  }
  if(reference&&!creativeRefs.some(ref=>ref.url===reference.url)){if(creativeRefs.length>=4)toast('最多保留 4 张参考图，请先移除一张。');else creativeRefs.push(reference);}
  const type=draft.type==='video'?'video':'image';
  $('#creator').innerHTML=`<div class="creator-layout"><header class="creator-heading"><div><p class="eyebrow">CREATE WITH A PROMPT</p><h2 id="creator-title">${type==='video'?'视频创作':'图片创作'}</h2><p>描述你的画面，生成图片并保存到私有记录。</p></div><button type="button" class="icon-button" data-close="creator" aria-label="关闭创作">${icon('x')}</button></header><form id="creative-form"><div class="creator-body"><section class="creator-composer"><div class="reference-heading"><span>${icon('image')}参考图</span><span id="creative-reference-count"></span></div><div id="creative-references" class="creative-references"></div><label class="reference-add">${icon('plus')}添加参考图<input id="creative-reference-input" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" aria-label="添加创作参考图"></label><p class="reference-note">参考图用于创作，不会作为已完成作品发布。本地选图刷新后需重新添加。</p><div class="creative-prompt-heading"><label for="creative-prompt">提示词</label><span id="creative-status" role="status">自动暂存</span></div><textarea id="creative-prompt" maxlength="8000" required placeholder="描述你想创作的主体、场景、光线和风格…">${escape(draft.prompt||'')}</textarea><div class="creative-prompt-tools"><span id="creative-length"></span><button type="button" data-action="copy-creative">${icon('copy')}复制</button><button type="button" data-action="export-creative">${icon('download')}导出</button></div><div class="creative-snippets"><button type="button" data-creative-snippet="soft natural light, gentle shadows">+ 柔和光线</button><button type="button" data-creative-snippet="cinematic composition, subtle film grain">+ 电影感</button><button type="button" data-creative-snippet="slow smooth camera movement, single continuous shot">+ 运镜</button></div><details class="creative-advanced"><summary>负面提示词</summary><textarea id="creative-negative" maxlength="2000" placeholder="描述不希望出现的元素">${escape(draft.negative||'')}</textarea></details></section><section class="creator-settings" aria-label="创作设置"><label class="field">创作名称<input id="creative-title" maxlength="70" placeholder="为这次创作取个名字" value="${escape(draft.title||'')}"></label><label class="field">创作类型<select id="creative-type"><option value="image" ${type==='image'?'selected':''}>图片</option><option value="video" ${type==='video'?'selected':''}>视频</option></select></label><label class="field">生成模型<select id="creative-model">${creativeModels(type).map(model=>'<option '+(draft.model===model?'selected':'')+'>'+model+'</option>').join('')}</select></label><label class="field">画面比例<select id="creative-ratio">${[...new Set(['3:4','1:1','16:9','9:16','4:3',...(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(draft.ratio||'')?[draft.ratio]:[])])].map(ratio=>'<option '+(draft.ratio===ratio?'selected':'')+'>'+ratio+'</option>').join('')}</select></label><label class="field">生成数量<select id="creative-count">${[1,2,3,4].map(count=>'<option '+(draft.count===count?'selected':'')+'>'+count+'</option>').join('')}</select></label><label class="field">风格分类<select id="creative-category">${categories.slice(1).map(category=>'<option '+(draft.category===category?'selected':'')+'>'+category+'</option>').join('')}</select></label><div class="generation-status"><span class="live-dot"></span>生成服务尚未连接<p>你可以先打磨提示词、整理参考图，保存草稿或导出。</p></div></section></div><footer class="creator-footer"><div>${creativeDraftId?'<button type="button" class="remove-draft" data-action="remove-creative">移除草稿</button>':'<span>创作草稿仅保存在当前浏览器</span>'}<button type="button" class="creator-publish-link" data-action="publish-creative">已有结果？发布作品 ${icon('arrow-up-right')}</button></div><div><button type="submit" class="button soft">${icon('bookmark')}保存草稿</button><button type="button" id="generate-button" class="button dark" disabled title="尚未连接生成服务">${icon('sparkles')}生成${type==='video'?'视频':'图片'}</button></div></footer></form></div>`;
  renderCreativeRefs();if(!$('#creator').open)$('#creator').showModal();persistCreative(false);
  $('#creative-form').addEventListener('input',event=>{if(event.target.type!=='file')persistCreative();});
  $('#creative-type').addEventListener('change',()=>{const type=$('#creative-type').value;$('#creative-model').innerHTML=creativeModels(type).map(model=>'<option>'+model+'</option>').join('');$('#creator-title').textContent=type==='video'?'视频创作':'图片创作';$('#generate-button').innerHTML=icon('sparkles')+'生成'+(type==='video'?'视频':'图片');persistCreative();});
  $('#creative-form').addEventListener('submit',event=>{event.preventDefault();const item=storeCreative(getCreative(),creativeDraftId);if(item){creativeDraftId=item.id;persistCreative(false);toast('创作草稿已保存，尚未发布作品');}});
  $('#creative-reference-input').addEventListener('change',async event=>{
    const input=event.target,files=[...input.files],session=creativeSession;input.disabled=true;
    try{for(const file of files){if(creativeRefs.length>=4){toast('最多添加 4 张参考图。');break;}if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)||!file.size||file.size>20*1024**2){toast('参考图支持 JPEG、PNG、WebP、GIF，单张不超过 20 MB。');continue;}try{const bitmap=await createImageBitmap(file);bitmap.close();if(session!==creativeSession)break;creativeRefs.push({url:URL.createObjectURL(file),name:file.name,file});}catch{toast('这张图片无法读取，请更换文件。');}}if(session===creativeSession){renderCreativeRefs();persistCreative();}}
    finally{input.value='';input.disabled=false;}
  });
  generationUI.attachCreator({draft,getCreative,references:()=>creativeRefs,changed:persistCreative});
}
function exportCreative(){const data=getCreative();if(!data.prompt){toast('先写下一段提示词。');return;}const url=URL.createObjectURL(new Blob([`${data.title||'创作提示词'}\n\n${data.prompt}\n\n负面提示词：${data.negative}\n模型：${data.model}\n比例：${data.ratio}\n`],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='LumaVision-creative-prompt.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('已发起提示词下载');}
function removeCreative(id=creativeDraftId){const item=state.drafts.find(item=>item.id===id);if(!item)return;const next=state.drafts.filter(draft=>draft.id!==item.id);if(!write('drafts',next))return;state.drafts=next;removedDraft=item;creativeDraftId=null;if($('#creator').open)$('#creator').close();render();toast('已移除创作草稿');$('#toast').insertAdjacentHTML('beforeend',' <button class="undo-button" data-action="undo-remove">撤销</button>');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),15000);}
async function copy(text,message='提示词已复制'){try{await navigator.clipboard.writeText(text);toast(message);}catch{toast('无法访问剪贴板，请选中提示词手动复制或导出。');}}
async function openPublisher(p=null){
  if(p?.cardOnly){const epoch=sessionEpoch;try{p=(await requestJson('/api/works/'+p.id)).work;}catch(error){toast(error.message);return;}if(epoch!==sessionEpoch)return;}
  if(publishing)return;
  if(!state.user){afterLogin=()=>openPublisher(p);openLogin();toast('登录后即可发布作品');return;}
  if(p?.uploaded&&!canEditWork(p)){toast('请在我的作品的作品下架分类中管理下架作品');return;}
  // 新发布需要审核通过的创作者身份；编辑自己已发布的作品不受限。
  if(!(p?.uploaded)&&(state.user.creatorStatus||'none')!=='approved'&&state.user.role!=='admin'){
    toast('发布作品需要创作者身份，请在个人资料页申请认证');
    go('profile');return;
  }
  if($('#detail').open)$('#detail').close();
  uploader?.dispose();
  editingRecord=p||null;
  editingId=editingRecord?.custom?editingRecord.id:null;
  uploadId=editingRecord?.uploaded?editingRecord.id:`work-${crypto.randomUUID()}`;
  lastSubmission=null;
  const draft=p||{};

  $('#editor').innerHTML=`<div class="editor-layout"><button class="icon-button close" data-close="editor" aria-label="关闭发布作品">${icon('x')}</button><p class="eyebrow">SHARE YOUR VISION</p><h2 id="editor-title">${editingRecord?.status==='withdrawn'?'编辑下架作品':editingRecord?.status==='draft'?'编辑发布草稿':editingRecord?.uploaded?'编辑已发布作品':'发布作品'}</h2><p class="editor-intro">上传已经完成的图片或视频，附上提示词，展示你的创作结果。</p>
<form id="prompt-form"><div class="editor-form">
<label class="field wide">作品名称<input id="edit-name" maxlength="70" placeholder="为这组作品取个名字" value="${escape(draft?.title||'')}" required></label>
<label class="field">创作类型<select id="edit-type"><option value="image" ${draft?.type!=='video'?'selected':''}>图片提示词</option><option value="video" ${draft?.type==='video'?'selected':''}>视频提示词</option></select></label>
<label class="field">适用模型<select id="edit-model"></select></label>
<div class="field wide"><div class="prompt-label"><label for="edit-prompt">提示词</label><label class="text-import">导入文本文件<input id="prompt-import" type="file" accept=".txt,.md,text/plain,text/markdown" aria-label="导入提示词文本文件"></label></div><textarea id="edit-prompt" maxlength="8000" placeholder="描述你的画面、光线与风格，也可以粘贴已有提示词…" required>${escape(draft?.prompt||'')}</textarea><span class="field-hint"><span>主体 + 场景 + 光线 + 风格${draft?.type==='video'?' + 镜头运动':''}</span><span id="char-count"></span></span></div>
<div class="editor-toolbar field wide" aria-label="添加风格片段"><button type="button" data-snippet="soft natural light, gentle shadows">+ 柔和光线</button><button type="button" data-snippet="cinematic composition, subtle film grain">+ 电影质感</button><button type="button" data-snippet="minimal composition, generous negative space">+ 极简构图</button><button type="button" data-snippet="slow smooth camera movement, single continuous shot">+ 运镜描述</button></div>
<div id="uploader" class="field wide upload-heading"></div>
<label class="field">画面比例<select id="edit-ratio">${['3:4','1:1','16:9','9:16','4:3'].map(r=>`<option ${draft?.ratio===r?'selected':''}>${r}</option>`).join('')}</select></label><label class="field">风格分类<select id="edit-category">${categories.slice(1).map(c=>`<option ${draft?.category===c?'selected':''}>${c}</option>`).join('')}</select></label>
</div><p id="publish-error" class="publish-error" role="alert" hidden></p><div class="upload-progress" hidden><div><span id="upload-status">正在上传…</span><span id="upload-percent">0%</span></div><progress max="100" value="0" aria-label="上传进度"></progress></div>
<div class="editor-bottom"><span>${editingRecord?.status==='withdrawn'?'保存修改后仍保持下架，提交审核后可重新发布。':editingRecord?.status==='draft'?'草稿仅自己可见，提交后进入审核。':editingRecord?.uploaded?'保存修改后作品会重新进入审核。':'提交后进入审核，通过后展示在灵感库。'}</span><div class="editor-buttons">${editingRecord?.status==='withdrawn'?'<button type="button" class="button soft" data-action="save-withdrawn-work">保存修改</button>':!editingRecord?.uploaded||editingRecord.status==='draft'?'<button type="button" class="button soft" data-action="save-publishing-draft">保存草稿</button>':''}<button type="submit" class="button dark" id="publish-button">${icon('arrow-up-right')}${editingRecord?.uploaded&&!['draft','withdrawn'].includes(editingRecord.status)?'保存并重新审核':'提交审核'}</button></div></div></form></div>`;
  fillModels(draft?.model);
  if(draft.ratio&&/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(draft.ratio)&&![...$('#edit-ratio').options].some(option=>option.value===draft.ratio))$('#edit-ratio').add(new Option(draft.ratio,draft.ratio,true,true));
  uploader=createUploader($('#uploader'),p?.media||[]);
  $('#editor').showModal();updateCount();
  $('#prompt-form').addEventListener('input',event=>{if(event.target.type==='file')return;updateCount();});
  $('#edit-type').addEventListener('change',()=>{fillModels();$('.field-hint>span').textContent='主体 + 场景 + 光线 + 风格'+($('#edit-type').value==='video'?' + 镜头运动':'');});
  $('#prompt-import').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    try{if(file.size>100*1024)throw new Error('提示词文件不能超过 100 KB。');const text=(await file.text()).replace(/^\uFEFF/,'').trim();if(!text||text.length>8000)throw new Error('提示词需要为 1 至 8000 字。');$('#edit-prompt').value=text;updateCount();$('#publish-error').hidden=true;}
    catch(error){publishError(error.message);}finally{event.target.value='';}
  });
  $('#prompt-form').addEventListener('submit',savePrompt);
}
function publishError(message){const element=$('#publish-error');if(!element){toast(message);return;}element.textContent=message;element.hidden=false;}
function lockComposer(value){
  publishing=value;$('#editor').setAttribute('aria-busy',String(value));
  $('#prompt-form').querySelectorAll('input,textarea,select,button').forEach(el=>el.disabled=value);
  $('#editor [data-close]').disabled=value;uploader?.setDisabled(value);
}
function fillModels(selected){const models=creativeModels($('#edit-type').value);if(selected&&!models.includes(selected))models.unshift(selected);$('#edit-model').innerHTML=models.map(m=>'<option '+(selected===m?'selected':'')+'>'+escape(m)+'</option>').join('');}
function updateCount(){$('#char-count').textContent=$('#edit-prompt').value.length+' / 8000';}
function getEditor(){return {title:$('#edit-name').value.trim(),prompt:$('#edit-prompt').value.trim(),type:$('#edit-type').value,model:$('#edit-model').value,ratio:$('#edit-ratio').value,category:$('#edit-category').value};}

async function savePrompt(event,intent='submit'){
  event?.preventDefault();if(publishing)return;
  if(uploader?.busy){publishError('正在读取所选文件，请稍后再发布。');return;}
  const data=getEditor();if(intent!=='draft'&&(!data.title||!data.prompt)){publishError('请填写作品名称和提示词。');return;}
  if(intent==='draft'&&!data.title&&!data.prompt&&!uploader.entries.length){publishError('先填写作品名称、提示词或添加附件，再保存草稿。');return;}
  const {files,manifest}=uploader.build();
  const payload={...data,intent,id:uploadId,revision:editingRecord?.uploaded?editingRecord.revision:0,media:manifest};
  if(editingRecord?.generated)payload.generationId=editingRecord.id;
  const fingerprint=JSON.stringify(payload)+files.map(file=>`${file.name}:${file.size}:${file.lastModified}`).join('|');
  if(lastSubmission?.fingerprint!==fingerprint)lastSubmission={fingerprint,requestId:crypto.randomUUID()};
  payload.requestId=lastSubmission.requestId;
  $('#publish-error').hidden=true;$('.upload-progress').hidden=false;lockComposer(true);
  const update=percent=>{$('progress').value=percent;$('#upload-percent').textContent=`${percent}%`;$('#upload-status').textContent=percent===100?'上传完成，正在保存作品…':'正在上传作品，请保持页面打开…';};update(0);
  try{
    const work=await publishWork(payload,files,update);
    invalidateWorkReads();
    state.myWorks=[work,...state.myWorks.filter(item=>item.id!==work.id)];
    // 重新提交后服务端已把作品移出公开列表，本地同步移除旧副本，避免画廊与服务器状态分叉。
    state.works=state.works.filter(item=>item.id!==work.id);
    if(work.status==='published')state.works.unshift(work);
    if(editingRecord?.custom&&!editingRecord.uploaded){const next=state.drafts.filter(item=>item.id!==editingRecord.id);if(write('drafts',next))state.drafts=next;}
    lockComposer(false);$('#editor').close();
    go('creations');
    if(work.status==='withdrawn'){state.workStatus='withdrawn';render();}
    toast(work.status==='withdrawn'?'修改已保存，作品仍保持下架':work.status==='draft'?'发布草稿已保存，可在我的作品中继续编辑':work.status==='pending'?(work.revision>1?'修改已提交，审核通过后更新展示':'作品已提交审核，通过后将展示在灵感库'):'作品已发布到灵感库');
  }catch(error){lockComposer(false);$('.upload-progress').hidden=true;publishError(error.message);}
}

document.addEventListener('click',event=>{
  if(!event.target.closest('.account-menu'))document.querySelectorAll('.account-menu[open]').forEach(menu=>menu.open=false);
  const button=event.target.closest('button,a');if(!button)return;
  if(button.dataset.view)go(button.dataset.view);
  if(button.dataset.author){const target='#user/'+button.dataset.author;document.querySelectorAll('.account-menu[open]').forEach(menu=>menu.open=false);if($('#detail').open)$('#detail').close();if(location.hash===target)openUserPage(button.dataset.author);else location.hash=target;}
  if(button.hasAttribute('data-review-approve'))reviewDecide(button.getAttribute('data-review-approve'),'approve');
  if(button.hasAttribute('data-review-reject'))openReject(button.getAttribute('data-review-reject'));
  if(button.hasAttribute('data-creator-approve'))creatorDecide(button.getAttribute('data-creator-approve'),'approve');
  if(button.hasAttribute('data-creator-reject'))openReject(button.getAttribute('data-creator-reject'),'creator');
  if(button.dataset.category){state.category=button.dataset.category;render();}
  if(button.dataset.type){state.type=button.dataset.type;render();}
  if(button.dataset.sort){state.sort=button.dataset.sort;render();}
  if(button.dataset.workStatus&&state.view==='creations'&&workStatusLabels[button.dataset.workStatus]){state.workStatus=state.workStatus===button.dataset.workStatus?'all':button.dataset.workStatus;render();}
  if(button.dataset.studioTab&&state.view==='drafts'&&Object.hasOwn(studioTabs,button.dataset.studioTab)){
    state.studioTab=button.dataset.studioTab;write('studio-tab',state.studioTab);render();
    if(state.user&&state.studioTab!=='drafts'){loadGenerations();if(state.studioTab==='submissions')loadMyWorks();}
  }
  if(button.dataset.publishGeneration){const record=state.generations.find(item=>item.id===button.dataset.publishGeneration);if(record)openPublisher(record);}
  if(button.dataset.generationDelete)removeGeneration(button.dataset.generationDelete);
  if(button.dataset.model){state.model=button.dataset.model;render();}
  if(button.dataset.apply){const p=findWork(button.dataset.apply);if(p)openCreator(p);}
  if(button.dataset.creativeEdit){const p=state.drafts.find(item=>item.id===button.dataset.creativeEdit);if(p)openCreator(p);}
  if(button.dataset.creativeDelete)removeCreative(button.dataset.creativeDelete);
  if(button.dataset.relatedCategory){const category=button.dataset.relatedCategory;$('#detail').close();state.category=category;render();}
  if(button.dataset.workEdit){const p=findWork(button.dataset.workEdit);if(p)openPublisher(p);}
  if(button.dataset.workDelete){const p=findWork(button.dataset.workDelete);if(p)removeWorkById(p);}
  if(button.dataset.workWithdraw){const p=findWork(button.dataset.workWithdraw);if(p)withdrawWork(p);}
  if(button.dataset.open)openPrompt(button.dataset.open);
  if(button.dataset.save)toggleSave(button.dataset.save);
  if(button.hasAttribute('data-detail-save')&&currentPrompt)toggleSave(currentPrompt.id);
  if(button.dataset.close&&!(button.dataset.close==='editor'&&publishing))document.getElementById(button.dataset.close)?.close();
  if(button.hasAttribute('data-media-index'))showMedia(Number(button.dataset.mediaIndex));
  if(button.dataset.snippet){const el=$('#edit-prompt');el.value=((el.value.trim()?el.value.trim()+', ':'')+button.dataset.snippet).slice(0,8000);updateCount();el.focus();}
  if(button.dataset.creativeSnippet){const el=$('#creative-prompt');el.value=(el.value.trim()+(el.value.trim()?', ':'')+button.dataset.creativeSnippet).slice(0,8000);persistCreative();el.focus();}
  if(button.hasAttribute('data-remove-reference')){const [ref]=creativeRefs.splice(Number(button.dataset.removeReference),1);if(ref?.file)URL.revokeObjectURL(ref.url);renderCreativeRefs();persistCreative();}
  switch(button.dataset.action){
    case 'user-next':if(userCursor){userHistory.push(userCurrentCursor);openUserPage(state.userViewId,userCursor);}break;
    case 'user-prev':if(userHistory.length)openUserPage(state.userViewId,userHistory.pop());break;
    case 'gallery-next':if(galleryCursor&&!galleryLoading){galleryHistory.push(galleryCurrentCursor);loadGalleryPage(galleryCursor);$('#cards').scrollIntoView({block:'start'});}break;
    case 'gallery-prev':if(galleryHistory.length&&!galleryLoading){loadGalleryPage(galleryHistory.pop());$('#cards').scrollIntoView({block:'start'});}break;
    case 'create':openCreator();break;
    case 'publish':openPublisher();break;
    case 'save-publishing-draft':savePrompt(null,'draft');break;
    case 'login':afterLogin=null;openLogin();break;
    case 'logout':logout();break;
    case 'open-profile':go('profile');break;
    case 'open-my-page':if(state.user){const target='#user/'+state.user.id;if(location.hash===target)openUserPage(state.user.id);else location.hash=target;}break;
    case 'open-review':go('review');break;
    case 'generation-settings':generationUI.openSettings();break;
    case 'edit-nickname':openNickname();break;
    case 'change-password':openPassword();break;
    case 'edit-social':openSocial(false);break;
    case 'apply-creator':openSocial(true);break;
    case 'back-page':go('explore');break;
    case 'copy-creative':{const text=$('#creative-prompt').value.trim();text?copy(text):toast('先写下一段提示词。');break;}
    case 'export-creative':exportCreative();break;
    case 'remove-creative':removeCreative();break;
    case 'publish-creative':{const data=getCreative();persistCreative(creativeEdited);$('#creator').close();openPublisher({...data,custom:false});break;}
    case 'search':document.body.classList.add('search-visible');$('#search').focus();$('#search').scrollIntoView({block:'center',behavior:'smooth'});break;
    case 'clear-filters':clearFilters();break;
    case 'reload-works':loadWorks();break;
    case 'reload-review':openReview();break;
    case 'media-prev':showMedia(activeMedia-1);break;
    case 'media-next':showMedia(activeMedia+1);break;
    case 'about':$('#about').showModal();break;
    case 'copy-detail':copy(currentPrompt.prompt);break;
    case 'edit-detail':openCreator(currentPrompt);break;
    case 'edit-work':openPublisher(currentPrompt);break;
    case 'save-withdrawn-work':savePrompt(null,'withdrawn');break;
    case 'reference-detail':openCreator(null,getPromptReference(currentPrompt));break;
    case 'copy-link':copy(location.href,'作品链接已复制');button.closest('details').open=false;break;
    case 'expand-prompt':{const text=$('#detail .prompt-text');const expanded=text.classList.toggle('expanded');button.textContent=expanded?'收起':'展开';button.setAttribute('aria-expanded',String(expanded));break;}
    case 'remove-draft':removeCreation();break;
    case 'undo-remove':restoreCreation();break;
    case 'reset':go('explore');break;
  }
});
let searchTimer;
$('#search').addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(render,180);});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!document.querySelector('dialog[open]')){event.preventDefault();document.body.classList.add('search-visible');$('#search').focus();}});
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog&&!(dialog.id==='editor'&&publishing)&&!(dialog.id==='auth'&&authDialog.busy)){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
function route(){
  const hash=location.hash.slice(1);
  if(hash.startsWith('prompt/')){let id;try{id=decodeURIComponent(hash.slice(7));}catch{return;}if(currentPrompt?.id!==id||!$('#detail').open)openPrompt(id);return;}
  if(hash.startsWith('user/')){const id=hash.slice(5);if(/^user-[0-9a-f-]{36}$/.test(id)){if(state.view!=='user'||state.userViewId!==id)openUserPage(id);return;}}
  if($('#detail').open)$('#detail').close();
  const view=['explore','collections','recent','creations','drafts','profile','review'].includes(hash)?hash:'explore';
  if(state.view!==view)setView(view);
  else if(view==='profile'||view==='review')renderPageView();
}
window.addEventListener('hashchange',route);
const categoryDisclosure=$('.sidebar-categories'),mobileCategories=matchMedia('(max-width:580px)');const syncCategories=()=>categoryDisclosure.open=mobileCategories.matches;syncCategories();mobileCategories.addEventListener('change',syncCategories);
$('.filter-row').appendChild($('.media-tabs'));
decorate();
sessionPromise=loadSession();
setView(location.hash.startsWith('#prompt/')?'explore':location.hash.slice(1)||'explore');
if(location.hash.startsWith('#prompt/')||location.hash.startsWith('#user/'))route();
if(storageIssue)toast('部分本地数据无法读取；你仍可浏览和导出提示词。');

$('#detail').addEventListener('close',()=>{if($('#detail').open)return;detailSeq++;$('#detail').querySelectorAll('video').forEach(video=>{video.pause();video.removeAttribute('src');video.load();});$('#detail').innerHTML='';currentPrompt=null;if(location.hash.startsWith('#prompt/'))history.replaceState(null,'','#'+detailReturnHash);});
$('#creator').addEventListener('close',()=>{if($('#creator').open)return;creativeSession++;creativeRefs.forEach(ref=>{if(ref.file)URL.revokeObjectURL(ref.url);});creativeRefs=[];creativePreview=null;$('#creator').innerHTML='';});
$('#editor').addEventListener('cancel',event=>{if(publishing)event.preventDefault();});
$('#editor').addEventListener('close',()=>{
  uploader?.dispose();uploader=null;
});
window.addEventListener('beforeunload',event=>{if(publishing){event.preventDefault();event.returnValue='';}});
loadWorks();

function clearFilters(){state.query='';state.category='全部灵感';state.type='all';state.model='all';state.workStatus='all';$('#search').value='';render();}
async function removeWorkById(work){
  if(!canManageWork(work)||!['draft','withdrawn'].includes(work.status))return;
  try{
    invalidateWorkReads();
    toast('正在删除作品…');
    const response=await fetch('/api/works/'+work.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:work.revision})});
    const result=await response.json();if(!response.ok)throw new Error(result.error);
    invalidateWorkReads();
    removedDraft=result.work;state.works=state.works.filter(item=>item.id!==work.id);state.myWorks=state.myWorks.filter(item=>item.id!==work.id);render();
    toast('已删除作品，可撤销');$('#toast').insertAdjacentHTML('beforeend',' <button class="undo-button" data-action="undo-remove">撤销</button>');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),15000);
  }catch(error){toast(error.message||'移除失败，请重试。');}
}
function confirmDelete({title,description,label}){
  const dialog=$('#confirm');
  if(dialog.open)return Promise.resolve(false);
  dialog.innerHTML=`<form class="mini-form"><button type="button" class="icon-button close" data-close="confirm" aria-label="关闭">${icon('x')}</button><p class="eyebrow">PLEASE CONFIRM</p><h2 id="confirm-title">${escape(title)}</h2><p class="confirm-copy">${escape(description)}</p><div class="mini-form-actions"><button type="button" class="button soft" data-close="confirm">取消</button><button type="submit" class="button dark">${escape(label)}</button></div></form>`;
  return new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;if(dialog.open)dialog.close();resolve(value);};
    dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();finish(true);});
    dialog.addEventListener('close',()=>finish(false),{once:true});
    dialog.showModal();
  });
}
async function removeGeneration(id){
  const record=state.generations.find(item=>item.id===id);if(!record)return;
  const confirmed=await confirmDelete({title:'删除这条生成记录？',description:'生成图片会从服务器删除且无法恢复；已用于投稿的记录需要先删除对应作品。',label:'删除记录'});
  if(!confirmed)return;
  try{await requestJson('/api/generations/'+id,{method:'DELETE'});}
  catch(error){toast(error.message||'删除失败，请重试。');return;}
  state.generations=state.generations.filter(item=>item.id!==id);
  if(currentPrompt?.id===id&&$('#detail').open)$('#detail').close();
  render();toast('已删除生成记录');
}
function openWithdrawReason(work){
  $('#reject').innerHTML=`<form id="withdraw-form" class="mini-form"><button type="button" class="icon-button close" data-close="reject" aria-label="关闭下架作品">${icon('x')}</button><p class="eyebrow">MODERATION</p><h2 id="reject-title">下架作品</h2><p>下架后仅作品创作者本人可以管理。</p><label class="field">下架原因（创作者可见）<textarea id="withdraw-note" maxlength="200" required placeholder="请说明下架原因，最多 200 字"></textarea></label><p id="withdraw-error" class="auth-error" role="alert" hidden></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="reject">取消</button><button type="submit" class="button dark">确认下架</button></div></form>`;
  $('#reject').showModal();
  $('#withdraw-form').addEventListener('submit',async event=>{
    event.preventDefault();const note=$('#withdraw-note').value.trim(),error=$('#withdraw-error');
    if(!note){error.textContent='请填写下架原因。';error.hidden=false;return;}
    const submit=$('#withdraw-form [type="submit"]');submit.disabled=true;
    const succeeded=await withdrawWork(work,note);
    if(succeeded)$('#reject').close();else{submit.disabled=false;error.textContent='下架失败，请检查网络或刷新作品后重试。';error.hidden=false;}
  });
}
async function withdrawWork(work,note){
  if(!canManageWork(work)||['draft','withdrawn'].includes(work.status))return;
  if(state.user.role==='admin'&&note===undefined){openWithdrawReason(work);return;}
  const control=document.querySelector(`[data-work-withdraw="${CSS.escape(work.id)}"]`);
  if(control?.disabled)return;
  if(control)control.disabled=true;
  invalidateWorkReads();toast('正在下架作品…');
  try{
    const {work:updated}=await requestJson('/api/works/'+work.id+'/withdraw',{method:'POST',body:{revision:work.revision,note}});
    invalidateWorkReads();
    state.works=state.works.filter(item=>item.id!==work.id);
    state.myWorks=state.myWorks.filter(item=>item.id!==work.id);if(updated.authorId===state.user.id)state.myWorks.unshift(updated);
    state.userWorks=state.userWorks.filter(item=>item.id!==work.id);
    state.reviewPending=state.reviewPending.filter(item=>item.id!==work.id);
    state.reviewRejected=state.reviewRejected.filter(item=>item.id!==work.id);
    if(currentPrompt?.id===work.id&&$('#detail').open)$('#detail').close();
    render();toast(updated.authorId===state.user.id?'作品已下架，可在我的作品的作品下架中管理':'作品已下架，创作者可查看原因并管理');return true;
  }catch(error){if(control)control.disabled=false;toast(error.message||'下架失败，请重试。');return false;}
}
async function removeCreation(){
  if(publishing)return;const item=editingRecord;if(!item)return;
  invalidateWorkReads();
  try{
    if(item.uploaded){
      lockComposer(true);const response=await fetch('/api/works/'+item.id,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:item.revision})});const result=await response.json();if(!response.ok)throw new Error(result.error);removedDraft=result.work;state.works=state.works.filter(p=>p.id!==item.id);state.myWorks=state.myWorks.filter(p=>p.id!==item.id);lockComposer(false);
    }else{const next=state.drafts.filter(p=>p.id!==item.id);if(!write('drafts',next))return;removedDraft=item;state.drafts=next;}
    $('#editor').close();render();toast('已移除这份创作');$('#toast').insertAdjacentHTML('beforeend',' <button class="undo-button" data-action="undo-remove">撤销</button>');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),15000);
  }catch(error){lockComposer(false);publishError(error.message||'移除失败，请重试。');}
}
async function restoreCreation(){
  const item=removedDraft;if(!item)return;
  invalidateWorkReads();
  try{
    if(item.uploaded){const response=await fetch('/api/works/'+item.id+'/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:item.revision})});const result=await response.json();if(!response.ok)throw new Error(result.error);if((result.work.status||'published')==='published')state.works=[result.work,...state.works.filter(p=>p.id!==item.id)];if(result.work.authorId===state.user?.id||(!result.work.authorId&&state.user)||(state.user?.role==='admin'&&result.work.status==='withdrawn'))state.myWorks=[result.work,...state.myWorks.filter(p=>p.id!==item.id)];}
    else{const next=[item,...state.drafts];if(!write('drafts',next))return;state.drafts=next;}
    removedDraft=null;render();toast('已恢复这份创作');
  }catch(error){toast(error.message||'恢复失败，请重试。');}
}

