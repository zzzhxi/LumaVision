// Copy only reviewed product sources; never copy local mail settings or runtime data.
import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..'), siteDirectory = process.argv[2] || 'sites';
if (!['sites', 'sites-current'].includes(siteDirectory)) throw new Error('Target must be sites or sites-current.');
const target = join(root, siteDirectory);
for (const dir of ['src', 'public', 'public/assets']) await mkdir(join(target, dir), { recursive: true });
const read = async name => (await readFile(join(root, name), 'utf8')).replace(/\r\n/g, '\n');
for (const name of ['index.html','app.js','styles.css','uploads.css','auth.css','auth-ui.js','studio.js','drafts.js','media.js','data.js','favicon.svg']) {
  let source = await read(name);
  if (name === 'media.js') source = source.slice(0, source.indexOf('export function publishWork')) + await readFile(join(target, 'src/upload-client.js'), 'utf8');
  await writeFile(join(target, 'public', name), source);
}
for (const name of await readdir(join(root, 'assets'))) if (/^[\w-]+\.(jpg|png|webp|svg)$/.test(name)) await copyFile(join(root,'assets',name),join(target,'public/assets',name));
let auth = await read('auth.mjs');
auth = auth.replace(/^import .*from 'node:fs\/promises';\n/m, '').replace(/^import .*from 'node:path';\n/m, '').replace(/^import .*from '\.\/email.mjs';\n/m, '').replace(/^import .*from '\.\/write-lock.mjs';\n/m, "import { authPersistence } from './persistence.mjs';\n");
const start = auth.indexOf('export function createAuthStore'), end = auth.indexOf('  const loadUsers=', start);
auth = auth.slice(0,start) + `export function createAuthStore(env,{sendCode}={}) {
  const persistence=authPersistence(env.DB);
  const ready=Promise.resolve();
  const serial=fn=>persistence.transaction(fn);
  const readJson=(name,fallback)=>persistence.read(name,fallback);
  const writeJson=(name,value)=>persistence.write(name,value);
` + auth.slice(end);
auth = auth.replace('process.env.ADMIN_EMAILS', 'env.ADMIN_EMAILS').replace(/const shouldSeedAdmin=.*?;/, 'const shouldSeedAdmin=(data,email)=>adminEmails().includes(email);');
// Keep the hosted retired-email guard when adapting the local authentication store.
auth = auth.replace('  const defaultNickname=', "  const blockedEmails=()=>String(env.AUTH_BLOCKED_EMAILS||'').split(',').map(item=>item.trim().toLowerCase()).filter(Boolean);\n  const defaultNickname=");
auth = auth.replace(/(async (?:requestCode|verifyCodeAndLogin)\([^\n]+\{\n      await ready;\n      const email=normalizeEmail\(rawEmail\);)/g, "$1\n      assert(!blockedEmails().includes(email),'此邮箱已停用。',403);");
await writeFile(join(target, 'src/auth.mjs'), auth);
let storage = await read('storage.mjs');
storage = storage.replace(/^import .*from 'node:fs\/promises';\n/m,'').replace(/^import .*from 'node:fs';\n/m,'').replace(/^import .*from 'node:path';\n/m,'').replace(/^import .*from '\.\/record-index.mjs';\n/m,'').replace(/^import .*from '\.\/write-lock.mjs';\n/m,"import { workPersistence } from './persistence.mjs';\n");
const ctor = storage.indexOf('export function createStore'), methods = storage.indexOf('  return {\n    ready,',ctor);
storage = storage.slice(0,ctor) + `export function createStore(env) {
  const persistence=workPersistence(env.DB);
  const ready=Promise.resolve();
  const get=async id=>{assert(workId.test(id),'作品编号不正确。');return persistence.get(id);};
  const all=()=>persistence.all();
  const commit=work=>persistence.commit(work);
  const serial=async(id,fn)=>{try{return await fn();}catch(error){if(error.status===409)throw error;throw error;}};
` + storage.slice(methods);
storage=storage.replace('close:index.close,', 'close(){},').replace('metrics:()=>({writeQueues:queues.size}),','metrics:()=>({storage:"D1"}),');
const prep=storage.indexOf('      const prepared=[];let preparedTotal=0;'), serialStart=storage.indexOf('      return await serial(id,async()=>{',prep);
storage=storage.slice(0,prep)+`      const prepared=files.map(media=>({media}));
      // The route resolves upload IDs from D1 and checks owner, target work, expiry and R2 bytes.
`+storage.slice(serialStart);
storage=storage.replace('await commit(work);committed=true;return work;', 'await commit(work);return work;');
const cleanup=storage.indexOf('      }finally{if(!committed)'), withdraw=storage.indexOf('    async withdraw(',cleanup);
storage=storage.slice(0,cleanup)+'    },\n'+storage.slice(withdraw);
const mediaMethod=storage.indexOf('    async media(name){');
storage=storage.slice(0,mediaMethod)+`    async media(name){
      assert(mediaId.test(name),'附件不存在。',404);
      const works=await persistence.owners(name);
      assert(works.length,'附件不存在。',404);
      const publicMedia=works.every(work=>!work.deletedAt&&(work.status||'published')==='published'&&!work.privateMediaIds?.includes(name)&&!work.draftMediaIds?.includes(name));
      return {private:!publicMedia,privateOwnerIds:works.map(work=>work.authorId).filter(Boolean)};
    }
  };
}
`;
await writeFile(join(target,'src/storage.mjs'),storage);
await writeFile(join(target,'src/work-query.mjs'),await read('work-query.mjs'));
let server=await read('server.mjs');
let routes=server.slice(server.indexOf('      // ---- 账号'),server.indexOf("      if(!['GET','HEAD'].includes(req.method))"));
routes=routes.replace('emailDeliveryMode()', 'emailDeliveryMode(env)');
routes=routes.replace(/      if\(path==='\/api\/user\/generations'[\s\S]*?(?=      const userPage=)/, "      if(path==='/api/user/generations'&&req.method==='GET'){await requireUser(req);json(res,200,{generations:[]});return;}\n");
const uploadStart=routes.indexOf("      if(path==='/api/works'&&req.method==='POST')"),uploadEnd=routes.indexOf('      const withdrawAction=',uploadStart);
routes=routes.slice(0,uploadStart)+`      if(path==='/api/works'&&req.method==='POST'){
        sameOrigin(req);const user=await requireUser(req);const input=await readJson(req,32768);
        const metadata=input.metadata;assert(metadata&&typeof metadata==='object','作品信息格式不正确。');
        const existing=await store.get(metadata.id);
        await canUpload(user,metadata.id);
        assert(!metadata.generationId,'生成服务尚未连接。',503);
        if(existing?.requestId===metadata.requestId){json(res,200,{work:(await withAuthors([existing]))[0]});return;}
        assert(Array.isArray(input.uploads)&&input.uploads.length<=12&&new Set(input.uploads).size===input.uploads.length,'上传列表不正确。');
        const files=[];
        for(const id of input.uploads){
          const row=await env.DB.prepare('SELECT * FROM uploads WHERE id=?').bind(id).first();
          assert(row&&row.owner===user.id&&row.work_id===metadata.id&&row.expires>Date.now(),'上传已失效，请重新上传。',403);
          const media=JSON.parse(row.data);assert(media.ready&&await env.BUCKET.head('media/'+id),'上传未完成。',409);
          for(const width of [320,640,1280])assert(await env.BUCKET.head('thumbnails/'+id+'/'+width+'.jpg'),'封面尚未上传完成。',409);
          delete media.ready;
          files.push({...media,thumbnailUrl:'/thumbnails/'+id+'/640.jpg',thumbnailSmall:'/thumbnails/'+id+'/320.jpg',thumbnailLarge:'/thumbnails/'+id+'/1280.jpg'});
        }
        let work;
        try{work=await store.save(metadata,files,{id:user.id,nickname:user.nickname});}
        catch(error){const current=await store.get(metadata.id);if(error.status===409&&current?.requestId===metadata.requestId)work=current;else throw error;}
        for(const id of input.uploads)await env.DB.prepare('DELETE FROM uploads WHERE id=? AND owner=?').bind(id,user.id).run();
        json(res,200,{work:(await withAuthors([work]))[0]});return;
      }
`+routes.slice(uploadEnd);
await writeFile(join(target,'src/routes.mjs'),`// Adapted from the local server; regenerate with scripts/sync-sites-source.mjs.
export async function productRoutes(context) {
  const {req,res,path,env,store,auth,assert,sessionUser,requireUser,requireAdmin,requireWorkOwner,withAuthors,listResponse,sameOrigin,readJson,body,json,sessionCookie,cookieValue,SESSION_COOKIE,SESSION_TTL,socialLinks,emailDeliveryMode,limits,metrics,canUpload,HttpError}=context;
${routes}
  return false;
}
`);
console.log('Sites product sources synchronized; local data and mail config excluded.');
