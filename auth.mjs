import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomInt, randomUUID, randomBytes, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { sendAuthCode } from './email.mjs';
import { renderCaptcha, CAPTCHA_ALPHABET } from './captcha.mjs';
import { REGISTRATION_EMAIL_DOMAIN_VALUES, emailDomain } from './email-domains.js';
import { HttpError } from './storage.mjs';
import { withWriteLock } from './write-lock.mjs';

const assert=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
const emailRule=/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const SESSION_COOKIE='luma_session';
export const SESSION_TTL=30*24*3600*1000;
const CODE_TTL=10*60*1000, CODE_RESEND=60*1000, CODE_MAX_ATTEMPTS=5;
const CAPTCHA_TTL=5*60*1000, CAPTCHA_MAX_ENTRIES=300;
const PASSWORD_MIN=8, PASSWORD_MAX=64;
const scryptAsync=promisify(scryptCallback);
const secretHash=(id,value)=>createHash('sha256').update(`${id}:${value}`).digest('hex');
const codeKey=(purpose,email)=>`${purpose}:${email}`;
const saltFor=()=>randomBytes(16);
const defaultCaptchaFactory=()=>{
  const text=Array.from({length:6},()=>CAPTCHA_ALPHABET[randomInt(0,CAPTCHA_ALPHABET.length)]).join('');
  return {text,image:renderCaptcha(text)};
};

function cleanPassword(value){
  assert(typeof value==='string','请输入密码。');
  assert(value.length>=PASSWORD_MIN&&value.length<=PASSWORD_MAX,`密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符。`);
  assert(/[A-Za-z]/.test(value)&&/\d/.test(value),'密码需同时包含字母和数字。');
  return value;
}
async function passwordHash(value){
  const salt=saltFor();
  const derived=Buffer.from(await scryptAsync(value,salt,64));
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
async function passwordMatches(value,stored){
  if(typeof stored!=='string'||typeof value!=='string')return false;
  const [scheme,salt,digest]=stored.split('$');
  if(scheme!=='scrypt'||!salt||!digest)return false;
  let expected;
  try{expected=Buffer.from(digest,'base64url');}catch{return false;}
  if(expected.length!==64)return false;
  const received=Buffer.from(await scryptAsync(value,Buffer.from(salt,'base64url'),64));
  return timingSafeEqual(expected,received);
}

// 图片提示中的十个社交平台;仅接受对应官方域名的 https 链接。
export const SOCIAL_PLATFORMS={
  instagram:{name:'Instagram',domains:['instagram.com']},
  x:{name:'X',domains:['x.com','twitter.com']},
  threads:{name:'Threads',domains:['threads.net','threads.com']},
  tiktok:{name:'TikTok',domains:['tiktok.com']},
  youtube:{name:'YouTube',domains:['youtube.com']},
  facebook:{name:'Facebook',domains:['facebook.com']},
  pinterest:{name:'Pinterest',domains:['pinterest.com']},
  behance:{name:'Behance',domains:['behance.net']},
  deviantart:{name:'DeviantArt',domains:['deviantart.com']},
  kofi:{name:'Ko-fi',domains:['ko-fi.com']}
};

export function socialLinks(value){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'社交主页格式不正确。');
  const entries=Object.entries(value);
  assert(entries.length<=Object.keys(SOCIAL_PLATFORMS).length,'社交主页数量超出限制。');
  const result={};
  for(const [key,raw] of entries){
    const platform=SOCIAL_PLATFORMS[key];assert(platform,'暂不支持该社交平台。');
    assert(typeof raw==='string'&&raw.length<=300,'社交主页链接过长。');
    let url;try{url=new URL(raw);}catch{throw new HttpError(400,'社交主页链接格式不正确，请填写完整网址。');}
    assert(url.protocol==='https:','社交主页需以 https:// 开头。');
    const host=url.hostname.toLowerCase();
    assert(platform.domains.some(domain=>host===domain||host.endsWith('.'+domain)),`请填写 ${platform.name}（${platform.domains[0]}）的链接。`);
    result[key]=url.toString();
  }
  return result;
}

function cleanNickname(value){
  assert(typeof value==='string','昵称格式不正确。');
  const nickname=value.trim().replace(/\s+/g,' ');
  assert(nickname.length>=1&&nickname.length<=20,'昵称需为 1-20 个字符。');
  return nickname;
}

// 创作者申请材料：至少一个有效社交主页链接。
function assertCreatorLinks(value){
  const links=socialLinks(value);
  assert(Object.keys(links).length>=1,'请至少填写一个有效的社交主页链接。');
  return links;
}

export function createAuthStore(directory,{sendCode=sendAuthCode,captchaFactory=defaultCaptchaFactory,registrationEmailDomains=REGISTRATION_EMAIL_DOMAIN_VALUES,seedFirstAdmin=true}={}){
  const authDir=join(directory,'auth');
  let queue=Promise.resolve();
  const loginFailures=new Map();
  const allowedRegistrationDomains=registrationEmailDomains===null?null:new Set(registrationEmailDomains.map(domain=>String(domain).toLowerCase()));
  const ready=mkdir(authDir,{recursive:true});
  const serial=fn=>{const next=queue.then(()=>withWriteLock(directory,'auth',fn));queue=next.catch(()=>{});return next;};
  const fileName=name=>join(authDir,name);
  async function readJson(name,fallback){
    try{return JSON.parse(await readFile(fileName(name),'utf8'));}
    catch(error){
      if(error.code==='ENOENT')return fallback;
      if(error instanceof SyntaxError){
        // 账号损坏必须从备份恢复；会话和验证码损坏时只使对应凭据失效。
        if(name==='sessions.json'||name==='codes.json'||name==='captchas.json'){console.error(`auth: ${name} 已损坏，对应凭据已失效。`);return fallback;}
        console.error(`auth: ${name} 已损坏，拒绝读写以防数据丢失，请从备份恢复。`);
        throw new HttpError(500,'本地账号数据已损坏，请从备份恢复 data/auth/。');
      }
      throw error;
    }
  }
  async function writeJson(name,value){
    const temp=fileName(`${name}.${randomUUID()}.tmp`);
    try{await writeFile(temp,JSON.stringify(value),'utf8');await rename(temp,fileName(name));}
    finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  const loadUsers=()=>readJson('users.json',{users:{}});
  const loadSessions=()=>readJson('sessions.json',{sessions:{}});
  const loadCodes=()=>readJson('codes.json',{codes:{}});
  const loadCaptchas=()=>readJson('captchas.json',{captchas:{}});
  const accountType=user=>user.accountType||((user.creatorStatus||'none')!=='none'?'creator':'personal');
  const importedUser=user=>user.importedAuthor===true||String(user.email||'').endsWith('@import.lumavision.local');
  const activeUser=user=>Boolean(user&&!user.disabledAt&&!user.deletedAt);
  const publicUser=user=>({id:user.id,email:user.email,nickname:user.nickname,social:user.social||{},role:user.role,accountType:accountType(user),onboardingComplete:user.onboardingComplete!==false,creatorStatus:user.creatorStatus||'none',creatorNote:user.creatorNote||null,hasPassword:typeof user.passwordHash==='string'&&user.passwordHash.startsWith('scrypt$'),createdAt:user.createdAt,avatarUrl:user.avatarUrl||null});
  // 公开主页只暴露“是否创作者”；审核中的申请与驳回原因属于隐私。
  const profileUser=user=>{
    const deleted=Boolean(user.deletedAt),approved=!deleted&&(user.creatorStatus||'none')==='approved';
    return {id:user.id,nickname:deleted?'已注销用户':user.nickname,creator:approved,social:approved?user.social||{}:{},createdAt:user.createdAt,avatarUrl:deleted?null:user.avatarUrl||null,deleted};
  };
  const adminUser=user=>({
    id:user.id,email:user.email,nickname:user.deletedAt?'已注销用户':user.nickname,role:user.role,accountType:accountType(user),
    creatorStatus:user.creatorStatus||'none',creatorNote:user.creatorNote||null,
    importedAuthor:importedUser(user),envManaged:adminEmails().includes(String(user.email||'').toLowerCase()),
    hasPassword:typeof user.passwordHash==='string'&&user.passwordHash.startsWith('scrypt$'),
    googleLinked:Boolean(user.googleId),onboardingComplete:user.onboardingComplete!==false,
    createdAt:user.createdAt||null,lastLoginAt:user.lastLoginAt||null,avatarUrl:user.deletedAt?null:user.avatarUrl||null,
    disabledAt:user.disabledAt||null,disabledReason:user.disabledReason||null,
    deletedAt:user.deletedAt||null
  });
  const activeAdmins=data=>Object.values(data.users).filter(user=>user.role==='admin'&&activeUser(user)&&!importedUser(user));
  const cleanNote=(value,max=200)=>{
    assert(value===undefined||typeof value==='string','备注格式不正确。');
    const note=typeof value==='string'?value.trim():'';
    assert(note.length<=max,`备注不能超过 ${max} 字。`);
    return note;
  };
  const normalizeEmail=email=>{
    assert(typeof email==='string'&&email.length<=120&&emailRule.test(email),'请输入有效的邮箱地址。');
    return email.trim().toLowerCase();
  };
  const assertRegistrationEmail=email=>{
    if(!allowedRegistrationDomains)return;
    assert(allowedRegistrationDomains.has(emailDomain(email)),'注册仅支持 163、QQ、Gmail、Outlook、126、Hotmail 常见个人邮箱。');
  };
  const adminEmails=()=>String(process.env.ADMIN_EMAILS||'').split(',').map(item=>item.trim().toLowerCase()).filter(Boolean);
  const defaultNickname=(email,nickname)=>cleanNickname(nickname||email.split('@')[0].slice(0,20));
  const shouldSeedAdmin=(data,email)=>adminEmails().includes(email)||(seedFirstAdmin&&!Object.values(data.users).some(item=>item.role==='admin'&&!item.deletedAt&&!importedUser(item)));
  function upsertUser(data,email,{nickname,googleId,avatarUrl,importedAuthor=false,passwordHash:hash,now=Date.now()}={}) {
    let user=Object.values(data.users).find(item=>item.email===email);
    if(!user){
      user={id:`user-${randomUUID()}`,email,nickname:defaultNickname(email,nickname),social:{},role:!importedAuthor&&shouldSeedAdmin(data,email)?'admin':'user',importedAuthor,accountType:'personal',onboardingComplete:false,creatorStatus:'none',creatorNote:null,googleId:googleId||null,avatarUrl:avatarUrl||null,passwordHash:hash||null,createdAt:now};
      data.users[user.id]=user;
    }else{
      if(googleId&&!user.googleId)user.googleId=googleId;
      if(avatarUrl&&!user.avatarUrl)user.avatarUrl=avatarUrl;
      if(hash&&!user.passwordHash)user.passwordHash=hash;
      if(user.role!=='admin'&&adminEmails().includes(email))user.role='admin';
    }
    return user;
  }
  function takeCode(codes,email,purpose,code,challengeId,now){
    const entry=codes.codes[codeKey(purpose,email)];
    assert(entry&&entry.challengeId===challengeId&&entry.purpose===purpose&&!entry.consumed&&entry.expiresAt>now&&typeof entry.hash==='string'&&/^[a-f0-9]{64}$/.test(entry.hash),'验证码已失效，请重新获取。',401);
    assert(entry.attempts<CODE_MAX_ATTEMPTS,'验证码错误次数过多，请重新获取。',429);
    const expected=Buffer.from(entry.hash,'hex'),received=Buffer.from(secretHash(challengeId,code),'hex');
    if(expected.length!==received.length||!timingSafeEqual(expected,received)){
      entry.attempts++;
      throw new HttpError(401,'验证码不正确，请重新输入。');
    }
    entry.consumed=true;
    return entry;
  }
  function takeCaptcha(data,challengeId,answer,now){
    const entry=data.captchas[challengeId];
    assert(entry&&!entry.consumed&&entry.expiresAt>now&&typeof entry.hash==='string'&&/^[a-f0-9]{64}$/.test(entry.hash),'图形验证码已失效，请重新获取。',401);
    entry.consumed=true;
    assert(typeof answer==='string'&&/^[A-Za-z0-9]{4,8}$/.test(answer.trim()),'请输入图形验证码。');
    const expected=Buffer.from(entry.hash,'hex'),received=Buffer.from(secretHash(challengeId,answer.trim().toUpperCase()),'hex');
    if(expected.length!==received.length||!timingSafeEqual(expected,received))throw new HttpError(401,'图形验证码不正确，请重新输入。');
    return entry;
  }
  // 账号停用或注销时，同时失效其会话与邮箱验证码/发送预留。
  async function revokeCredentials(email,userId){
    const sessions=await loadSessions();
    let sessionsChanged=false;
    for(const [token,session] of Object.entries(sessions.sessions||{})){
      if(session.userId===userId){delete sessions.sessions[token];sessionsChanged=true;}
    }
    if(sessionsChanged)await writeJson('sessions.json',sessions);
    const codes=await loadCodes();
    let codesChanged=false;
    const matches=key=>key===email||key.endsWith(`:${email}`);
    for(const key of Object.keys(codes.codes||{}))if(matches(key)){delete codes.codes[key];codesChanged=true;}
    for(const key of Object.keys(codes.reservations||{}))if(matches(key)){delete codes.reservations[key];codesChanged=true;}
    if(codesChanged)await writeJson('codes.json',codes);
  }
  return {
    ready,
    normalizeEmail,
    async requestCode(rawEmail,options={},now=Date.now()){
      if(typeof options==='number'){now=options;options={};}
      const {purpose='register',requireNew=false,requireExisting=false}=options;
      await ready;
      const email=normalizeEmail(rawEmail);
      assert(!email.endsWith('@import.lumavision.local'),'导入作者不支持邮箱登录。',403);
      if(purpose==='register')assertRegistrationEmail(email);
      if(requireNew||requireExisting){
        const users=await loadUsers();
        const existing=Object.values(users.users).find(user=>user.email===email);
        if(requireNew)assert(!existing,'该邮箱已注册，请直接登录。',409);
        if(requireExisting)assert(existing&&activeUser(existing),purpose==='reset'?'该邮箱尚未注册。':'该账号已停用，请联系管理员。',purpose==='reset'?404:403);
      }
      const challengeId=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
      const key=codeKey(purpose,email);
      await serial(async()=>{
        const data=await loadCodes();
        data.reservations||={};
        for(const [key,entry] of Object.entries(data.reservations))if(entry.expiresAt<=now)delete data.reservations[key];
        assert(!data.reservations[key],'验证码正在发送，请稍后再试。',429);
        const previous=data.codes[key];
        assert(!previous||now-previous.sentAt>=CODE_RESEND,'请稍等 60 秒后再获取验证码。',429);
        assert(Object.values(data.codes).filter(entry=>now-entry.sentAt<CODE_RESEND).length+Object.keys(data.reservations).length<20,'验证码请求过于频繁，请稍后再试。',429);
        for(const [key,entry] of Object.entries(data.codes))if(now-entry.sentAt>24*60*60*1000)delete data.codes[key];
        data.reservations[key]={challengeId,expiresAt:now+60000};
        await writeJson('codes.json',data);
      });
      let timer;
      try{
        const delivery=await Promise.race([sendCode({email,code,challengeId,purpose}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new HttpError(503,'验证码发送超时，请稍后重试。')),30000);})]);
        await serial(async()=>{
          const data=await loadCodes();
          assert(data.reservations?.[key]?.challengeId===challengeId,'验证码请求已失效，请重新获取。',409);
          const users=await loadUsers(),existing=Object.values(users.users).find(user=>user.email===email);
          assert(purpose==='register'?!existing:Boolean(existing&&activeUser(existing)),'验证码请求已失效，请重新获取。',409);
          data.codes[key]={challengeId,purpose,hash:secretHash(challengeId,code),sentAt:now,expiresAt:now+CODE_TTL,attempts:0,consumed:false};
          delete data.reservations[key];
          await writeJson('codes.json',data);
        });
        return {challengeId,expiresAt:now+CODE_TTL,retryAt:now+CODE_RESEND,...delivery};
      }catch(error){
        await serial(async()=>{
          const data=await loadCodes();
          if(data.reservations?.[key]?.challengeId===challengeId){delete data.reservations[key];await writeJson('codes.json',data);}
        });
        throw error;
      }finally{clearTimeout(timer);}
    },
    async createCaptcha(now=Date.now()){
      await ready;
      const generated=captchaFactory();
      const text=String(generated.text).toUpperCase();
      const challengeId=randomUUID();
      await serial(async()=>{
        const data=await loadCaptchas();
        data.captchas||={};
        for(const [key,entry] of Object.entries(data.captchas))if(entry.expiresAt<=now)delete data.captchas[key];
        assert(Object.keys(data.captchas).length<CAPTCHA_MAX_ENTRIES,'图形验证码请求过于频繁，请稍后再试。',429);
        data.captchas[challengeId]={hash:secretHash(challengeId,text),expiresAt:now+CAPTCHA_TTL,consumed:false};
        await writeJson('captchas.json',data);
      });
      return {challengeId,image:`data:image/png;base64,${Buffer.from(generated.image).toString('base64')}`,expiresAt:now+CAPTCHA_TTL};
    },
    async register({email:rawEmail,code,challengeId,password,captchaId,captcha,now=Date.now()}={}){
      await ready;
      const email=normalizeEmail(rawEmail);
      assert(!email.endsWith('@import.lumavision.local'),'该邮箱不能用于注册。',403);
      assertRegistrationEmail(email);
      assert(typeof code==='string'&&/^\d{6}$/.test(code),'请输入 6 位数字验证码。');
      assert(typeof challengeId==='string'&&challengeId.length<=80,'请先获取验证码。');
      assert(typeof captchaId==='string'&&captchaId.length<=80,'请先获取图形验证码。');
      const cleanedPassword=cleanPassword(password);
      return serial(async()=>{
        const data=await loadUsers();
        assert(!Object.values(data.users).some(user=>user.email===email),'该邮箱已注册，请直接登录。',409);
        const captchas=await loadCaptchas();
        try{takeCaptcha(captchas,captchaId,captcha,now);}
        finally{await writeJson('captchas.json',captchas);}
        const codes=await loadCodes();
        try{takeCode(codes,email,'register',code,challengeId,now);}
        catch(error){await writeJson('codes.json',codes);throw error;}
        const hash=await passwordHash(cleanedPassword);
        const user=upsertUser(data,email,{passwordHash:hash,now});
        await writeJson('codes.json',codes);
        await writeJson('users.json',data);
        return user;
      });
    },
    async loginWithPassword(rawEmail,password,now=Date.now()){
      await ready;
      const email=normalizeEmail(rawEmail);
      const failure=loginFailures.get(email);
      if(failure&&failure.lockedUntil<=now&&now-(failure.updatedAt||0)>10*60*1000)loginFailures.delete(email);
      else if(failure?.lockedUntil>now)throw new HttpError(429,'登录尝试次数过多，请 10 分钟后再试。');
      const candidate=typeof password==='string'?password:'';
      const data=await loadUsers(),user=Object.values(data.users).find(item=>item.email===email);
      let valid=false;
      if(user&&typeof user.passwordHash==='string')valid=await passwordMatches(candidate,user.passwordHash);
      else await scryptAsync(candidate,Buffer.from('lumavision-login-placeholder'),64);
      if(!valid){
        const count=(loginFailures.get(email)?.count||0)+1;
        if(loginFailures.size>=2000)loginFailures.delete(loginFailures.keys().next().value);
        loginFailures.set(email,{count,updatedAt:now,lockedUntil:count>=5?now+10*60*1000:0});
        throw new HttpError(401,'邮箱或密码不正确。');
      }
      assert(activeUser(user),'该账号已停用，请联系管理员。',403);
      loginFailures.delete(email);
      return user;
    },
    async resetPassword({email:rawEmail,code,challengeId,password,now=Date.now()}={}){
      await ready;
      const email=normalizeEmail(rawEmail);
      assert(typeof code==='string'&&/^\d{6}$/.test(code),'请输入 6 位数字验证码。');
      assert(typeof challengeId==='string'&&challengeId.length<=80,'请先获取验证码。');
      const cleanedPassword=cleanPassword(password);
      return serial(async()=>{
        const data=await loadUsers(),user=Object.values(data.users).find(item=>item.email===email);
        assert(user&&activeUser(user),'验证码已失效，请重新获取。',401);
        const codes=await loadCodes();
        try{takeCode(codes,email,'reset',code,challengeId,now);}
        catch(error){await writeJson('codes.json',codes);throw error;}
        const hash=await passwordHash(cleanedPassword);
        user.passwordHash=hash;
        user.passwordChangedAt=now;
        await writeJson('codes.json',codes);
        await writeJson('users.json',data);
        loginFailures.delete(email);
        return user;
      });
    },
    async changePassword(userId,{code,challengeId,password,now=Date.now()}={}){
      await ready;
      assert(typeof code==='string'&&/^\d{6}$/.test(code),'请输入 6 位数字验证码。');
      assert(typeof challengeId==='string'&&challengeId.length<=80,'请先获取验证码。');
      const cleanedPassword=cleanPassword(password);
      return serial(async()=>{
        const data=await loadUsers(),user=data.users[userId];
        assert(user,'用户不存在。',404);
        assert(activeUser(user),'该账号已停用，请联系管理员。',403);
        const codes=await loadCodes();
        try{takeCode(codes,user.email,'password',code,challengeId,now);}
        catch(error){await writeJson('codes.json',codes);throw error;}
        const hash=await passwordHash(cleanedPassword);
        user.passwordHash=hash;
        user.passwordChangedAt=now;
        await writeJson('codes.json',codes);
        await writeJson('users.json',data);
        loginFailures.delete(user.email);
        return user;
      });
    },
    async completeOnboarding(userId,{nickname,accountType:type,social,now=Date.now()}={}){
      await ready;
      assert(type==='personal'||type==='creator','请选择个人用户或创作者。');
      const links=type==='creator'?assertCreatorLinks(social):{};
      return serial(async()=>{
        const data=await loadUsers(),user=data.users[userId];
        assert(user,'用户不存在。',404);
        assert(activeUser(user),'该账号已停用，请联系管理员。',403);
        assert(user.onboardingComplete===false,'账号身份已设置，可在个人资料页申请创作者。',409);
        if(typeof nickname==='string'&&nickname.trim())user.nickname=cleanNickname(nickname);
        user.accountType=type;
        user.social=links;
        user.creatorStatus=type==='creator'?'pending':'none';
        user.creatorRequestedAt=type==='creator'?now:null;
        user.creatorNote=null;
        user.onboardingComplete=true;
        await writeJson('users.json',data);
        return user;
      });
    },
    async userByEmail(email){const data=await loadUsers();return Object.values(data.users).find(user=>user.email===email)||null;},
    async userById(id){const data=await loadUsers();return data.users[id]||null;},
    async upsertByEmail(rawEmail,options={}){
      await ready;
      const email=normalizeEmail(rawEmail);
      assert(!email.endsWith('@import.lumavision.local'),'请使用导入作者专用入口。');
      return serial(async()=>{
        const data=await loadUsers(),user=upsertUser(data,email,options);
        await writeJson('users.json',data);
        return user;
      });
    },
    async upsertImportedAuthor(account,nickname){
      await ready;
      assert(typeof account==='string'&&/^[A-Za-z0-9_]{1,15}$/.test(account),'导入账号不正确。');
      return serial(async()=>{
        const data=await loadUsers(),user=upsertUser(data,`${account.toLowerCase()}@import.lumavision.local`,{nickname,importedAuthor:true});
        await writeJson('users.json',data);return user;
      });
    },
    async profilesByIds(ids){const data=await loadUsers();return new Map(ids.map(id=>[id,data.users[id]?profileUser(data.users[id]):null]));},
    async createSession(userId,now=Date.now()){
      return serial(async()=>{
        const users=await loadUsers(),user=users.users[userId];
        assert(user&&activeUser(user),'该账号已停用，请联系管理员。',403);
        user.lastLoginAt=now;
        await writeJson('users.json',users);
        const data=await loadSessions();
        for(const [key,session] of Object.entries(data.sessions))if(session.expiresAt<now)delete data.sessions[key];
        const token=randomBytes(32).toString('hex');
        data.sessions[token]={userId,expiresAt:now+SESSION_TTL};
        await writeJson('sessions.json',data);
        return {token,expiresAt:now+SESSION_TTL};
      });
    },
    async sessionUser(token,now=Date.now()){
      if(!token||typeof token!=='string'||token.length>128)return null;
      const data=await loadSessions();const session=data.sessions[token];
      if(!session||session.expiresAt<now)return null;
      const user=await this.userById(session.userId);
      return activeUser(user)?user:null;
    },
    async destroySession(token){
      if(!token)return;
      await serial(async()=>{
        const data=await loadSessions();
        if(data.sessions[token]){delete data.sessions[token];await writeJson('sessions.json',data);}
      });
    },
    async updateProfile(userId,{nickname,social}){
      return serial(async()=>{
        const data=await loadUsers();const user=data.users[userId];
        assert(user,'用户不存在。',404);
        assert(activeUser(user),'该账号已停用，请联系管理员。',403);
        if(nickname!==undefined)user.nickname=cleanNickname(nickname);
        if(social!==undefined)user.social=socialLinks(social);
        await writeJson('users.json',data);return user;
      });
    },
    // 个人用户申请成为创作者（或被驳回后重新申请）。
    async requestCreator(userId,{social,now=Date.now()}={}){
      await ready;
      const links=assertCreatorLinks(social);
      return serial(async()=>{
        const data=await loadUsers();const user=data.users[userId];
        assert(user,'用户不存在。',404);
        assert(activeUser(user),'该账号已停用，请联系管理员。',403);
        const status=user.creatorStatus||'none';
        assert(status!=='pending','已提交申请，请等待审核。',409);
        assert(status!=='approved','你已经是创作者。',409);
        user.social=links;
        user.accountType='creator';
        user.onboardingComplete=true;
        user.creatorStatus='pending';
        user.creatorRequestedAt=now;
        user.creatorNote=null;
        user.creatorReviewedAt=null;
        await writeJson('users.json',data);return user;
      });
    },
    async reviewCreator(id,{decision,note,actorId,now=Date.now()}={}){
      await ready;assert(decision==='approve'||decision==='reject','审核操作不支持。');
      return serial(async()=>{
        const data=await loadUsers();const user=data.users[id];
        if(actorId!==undefined){
          const actor=data.users[actorId];
          assert(actor?.role==='admin'&&activeUser(actor),'仅管理员可以访问管理后台。',403);
        }
        assert(user,'用户不存在。',404);
        assert(activeUser(user),'该账号当前不可审核。',409);
        assert((user.creatorStatus||'none')==='pending','该账号没有待审核的创作者申请。',409);
        if(decision==='approve'){
          user.creatorStatus='approved';user.creatorNote=null;
        }else{
          assert(typeof note==='string'&&note.trim().length>0&&note.trim().length<=200,'请填写 200 字以内的未通过原因。');
          user.creatorStatus='rejected';user.creatorNote=note.trim();
        }
        user.creatorReviewedAt=now;
        await writeJson('users.json',data);return user;
      });
    },
    async listCreators(status){
      await ready;assert(['pending','rejected'].includes(status),'申请状态不支持。');
      const data=await loadUsers();
      return Object.values(data.users)
        .filter(user=>activeUser(user)&&(user.creatorStatus||'none')===status)
        .sort((a,b)=>(b.creatorRequestedAt||0)-(a.creatorRequestedAt||0))
        .map(publicUser);
    },
    async assertActiveAdmin(userId){
      await ready;
      const data=await loadUsers(),user=data.users[userId];
      assert(user?.role==='admin'&&activeUser(user),'仅管理员可以访问管理后台。',403);
      return user;
    },
    async listUsersForAdmin({q='',role='all',status='all',creatorStatus='all',kind='all',page=1,limit=20}={}){
      await ready;
      assert(typeof q==='string'&&q.length<=120,'搜索条件过长。');
      assert(['all','user','admin'].includes(role),'角色筛选不支持。');
      assert(['all','active','disabled','deleted'].includes(status),'账号状态筛选不支持。');
      assert(['all','none','pending','approved','rejected'].includes(creatorStatus),'创作者状态筛选不支持。');
      assert(['all','login','imported'].includes(kind),'账号类型筛选不支持。');
      const pageNumber=Number(page),pageSize=Number(limit);
      assert(Number.isInteger(pageNumber)&&pageNumber>=1,'页码不正确。');
      assert(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=50,'每页数量需为 1-50。');
      const data=await loadUsers(),allUsers=Object.values(data.users);
      const visible=allUsers.filter(user=>!user.deletedAt);
      const counts={
        total:visible.length,
        admins:visible.filter(user=>user.role==='admin'&&activeUser(user)&&!importedUser(user)).length,
        disabled:visible.filter(user=>user.disabledAt).length,
        creators:visible.filter(user=>(user.creatorStatus||'none')==='approved').length,
        pendingCreators:visible.filter(user=>(user.creatorStatus||'none')==='pending'&&!user.disabledAt).length,
        imported:visible.filter(importedUser).length,
        deleted:allUsers.filter(user=>user.deletedAt).length
      };
      const query=q.trim().toLowerCase();
      const filtered=allUsers.filter(user=>{
        if(status==='all'&&user.deletedAt)return false;
        if(status==='active'&&(!activeUser(user)||user.deletedAt))return false;
        if(status==='disabled'&&(user.deletedAt||!user.disabledAt))return false;
        if(status==='deleted'&&!user.deletedAt)return false;
        if(role!=='all'&&user.role!==role)return false;
        if(creatorStatus!=='all'&&(user.creatorStatus||'none')!==creatorStatus)return false;
        if(kind==='login'&&importedUser(user))return false;
        if(kind==='imported'&&!importedUser(user))return false;
        if(query&&![user.email,user.nickname,user.id].join(' ').toLowerCase().includes(query))return false;
        return true;
      }).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||b.id.localeCompare(a.id));
      const total=filtered.length,pages=Math.max(1,Math.ceil(total/pageSize)),currentPage=Math.min(pageNumber,pages);
      const users=filtered.slice((currentPage-1)*pageSize,currentPage*pageSize).map(adminUser);
      return {users,total,page:currentPage,pages,limit:pageSize,counts};
    },
    async adminUpdateUser(actorId,id,changes={},now=Date.now()){
      await ready;
      assert(/^user-[0-9a-f-]{36}$/.test(id),'用户编号不正确。');
      assert(changes&&typeof changes==='object'&&!Array.isArray(changes),'账号修改信息不正确。');
      const keys=Object.keys(changes),allowed=['role','creatorStatus','creatorNote','disabled','disabledReason'];
      assert(keys.length>0,'没有需要保存的修改。');
      assert(keys.every(key=>allowed.includes(key)),'账号修改信息不正确。');
      if(changes.role!==undefined)assert(['user','admin'].includes(changes.role),'角色不支持。');
      if(changes.creatorStatus!==undefined)assert(['none','approved','rejected'].includes(changes.creatorStatus),'创作者状态不支持。');
      if(changes.disabled!==undefined)assert(typeof changes.disabled==='boolean','停用状态不正确。');
      if(changes.creatorNote!==undefined)assert(changes.creatorStatus==='rejected','只有驳回时需要填写原因。');
      if(changes.disabledReason!==undefined)assert(changes.disabled===true,'只有停用时可以填写原因。');
      return serial(async()=>{
        const data=await loadUsers(),actor=data.users[actorId],user=data.users[id];
        assert(actor?.role==='admin'&&activeUser(actor),'仅管理员可以访问管理后台。',403);
        assert(user,'用户不存在。',404);
        assert(!user.deletedAt,'已注销账号不能修改。',409);
        assert(!importedUser(user),'导入作者档案为只读。',403);
        const self=actorId===id,envManaged=adminEmails().includes(String(user.email||'').toLowerCase());
        if(self&&(changes.role!==undefined||changes.disabled!==undefined))throw new HttpError(403,'不能修改自己的角色或停用状态。');
        if(envManaged&&(changes.role!==undefined||changes.disabled!==undefined))throw new HttpError(403,'该账号由 ADMIN_EMAILS 管理，请先修改环境变量。');
        const ensureAdminRemains=()=>{
          if(user.role==='admin'&&activeAdmins(data).filter(item=>item.id!==user.id).length<1)throw new HttpError(409,'至少需要保留一个有效管理员。');
        };
        let revoke=false;
        if(changes.role!==undefined&&changes.role!==user.role){
          if(changes.role==='user')ensureAdminRemains();
          user.role=changes.role;
        }
        if(changes.disabled!==undefined){
          if(changes.disabled){
            if(!user.disabledAt){
              ensureAdminRemains();
              user.disabledAt=now;user.disabledBy=actorId;user.disabledReason=cleanNote(changes.disabledReason)||null;
            }else if(changes.disabledReason!==undefined){
              user.disabledReason=cleanNote(changes.disabledReason)||null;
            }
            revoke=true;
          }else{
            user.disabledAt=null;user.disabledBy=null;user.disabledReason=null;
          }
        }
        if(changes.creatorStatus!==undefined){
          if(changes.creatorStatus==='approved'){
            user.creatorStatus='approved';user.creatorNote=null;user.creatorReviewedAt=now;user.accountType='creator';user.onboardingComplete=true;
          }else if(changes.creatorStatus==='rejected'){
            assert((user.creatorStatus||'none')!=='none','该账号没有可驳回的创作者申请。',409);
            const note=cleanNote(changes.creatorNote);
            assert(note.length>0,'请填写 200 字以内的未通过原因。');
            user.creatorStatus='rejected';user.creatorNote=note;user.creatorReviewedAt=now;user.accountType='personal';user.onboardingComplete=true;
          }else{
            user.creatorStatus='none';user.creatorNote=null;user.creatorReviewedAt=now;user.accountType='personal';
          }
        }
        user.adminUpdatedAt=now;
        if(revoke)await revokeCredentials(user.email,user.id);
        await writeJson('users.json',data);
        return adminUser(user);
      });
    },
    async adminDeleteUser(actorId,id,{confirmEmail}={},now=Date.now()){
      await ready;
      assert(/^user-[0-9a-f-]{36}$/.test(id),'用户编号不正确。');
      assert(typeof confirmEmail==='string','请输入完整邮箱确认注销。');
      return serial(async()=>{
        const data=await loadUsers(),actor=data.users[actorId],user=data.users[id];
        assert(actor?.role==='admin'&&activeUser(actor),'仅管理员可以访问管理后台。',403);
        assert(user,'用户不存在。',404);
        assert(!user.deletedAt,'该账号已注销。',409);
        assert(actorId!==id,'不能注销自己的账号。',403);
        assert(!importedUser(user),'导入作者档案为只读。',403);
        if(adminEmails().includes(String(user.email||'').toLowerCase()))throw new HttpError(403,'该账号由 ADMIN_EMAILS 管理，请先修改环境变量。');
        if(user.role==='admin'&&activeAdmins(data).filter(item=>item.id!==user.id).length<1)throw new HttpError(409,'至少需要保留一个有效管理员。');
        assert(confirmEmail.trim().toLowerCase()===String(user.email||'').toLowerCase(),'请输入完整邮箱确认注销。');
        const oldEmail=user.email;
        user.deletedAt=now;user.deletedBy=actorId;
        user.email=`deleted-${user.id.slice('user-'.length)}@deleted.lumavision.local`;
        user.nickname='已注销用户';user.social={};user.role='user';user.accountType='personal';
        user.onboardingComplete=true;user.creatorStatus='none';user.creatorNote=null;user.creatorReviewedAt=now;
        user.creatorRequestedAt=null;user.passwordHash=null;user.passwordChangedAt=null;user.googleId=null;user.avatarUrl=null;
        user.disabledAt=null;user.disabledBy=null;user.disabledReason=null;user.lastLoginAt=null;
        user.importedAuthor=false;user.adminUpdatedAt=now;
        await revokeCredentials(oldEmail,user.id);
        await writeJson('users.json',data);
        return adminUser(user);
      });
    },
    publicUser,profileUser,adminUser
  };
}
