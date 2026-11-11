import { mkdir, readFile, writeFile, rename, readdir, unlink, stat, open, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRecordIndex, limitedRead } from './record-index.mjs';
import { withWriteLock } from './write-lock.mjs';

export const limits = { count:12, image:20*1024**2, video:100*1024**2, total:200*1024**2 };
export class HttpError extends Error {
  constructor(status,message) { super(message); this.status=status; }
}
const assert=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
const workId=/^work-[0-9a-f-]{36}$/;
const mediaId=/^[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/;

// Check the content, not the filename. Active SVG/HTML uploads are never accepted.
export function identify(bytes) {
  if(bytes.length<12)return null;
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return {mime:'image/jpeg',ext:'jpg',type:'image'};
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png',type:'image'};
  if(['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return {mime:'image/gif',ext:'gif',type:'image'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return {mime:'image/webp',ext:'webp',type:'image'};
  if(bytes.toString('ascii',4,8)==='ftyp'&&/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)/.test(bytes.toString('ascii',8,12)))return {mime:'video/mp4',ext:'mp4',type:'video'};
  if(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))&&bytes.subarray(0,256).includes(Buffer.from('webm')))return {mime:'video/webm',ext:'webm',type:'video'};
  return null;
}
function cleanText(value,name,max,required=false){
  assert(typeof value==='string',`${name}格式不正确。`);const result=value.trim();
  assert(result.length<=max&&(!required||result.length>0),`${name}${required?'不能为空，且':''}不能超过 ${max} 字。`);return result;
}
export function createStore(directory){
  const worksDir=join(directory,'works'),mediaDir=join(directory,'media');
  const index=createRecordIndex(worksDir,workId);
  const queues=new Map();
  const ready=Promise.all([mkdir(worksDir,{recursive:true}),mkdir(mediaDir,{recursive:true})]).then(()=>index.snapshot());
  const serial=(id,fn)=>{
    const next=(queues.get(id)||Promise.resolve()).then(()=>withWriteLock(directory,id,fn));
    const settled=next.catch(()=>{});queues.set(id,settled);
    settled.finally(()=>{if(queues.get(id)===settled)queues.delete(id);});return next;
  };
  async function get(id){
    assert(workId.test(id),'作品编号不正确。');
    try{return JSON.parse(await limitedRead(join(worksDir,`${id}.json`)));}
    catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  // 列表读取容忍单个损坏文件（跳过并告警），避免一个坏文件打挂整个列表；
  // 按 id 读取保持严格：静默当作不存在会让保存覆盖损坏记录、revision 归零。
  async function all(){await ready;return [...(await index.snapshot()).records.values()];}
  async function commit(work){
    const temp=join(worksDir,`${work.id}.${randomUUID()}.tmp`);
    try{await writeFile(temp,JSON.stringify(work,null,2),{flag:'wx'});await rename(temp,join(worksDir,`${work.id}.json`));index.upsert(work);}
    finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')console.warn('storage: 临时记录清理失败',work.id,error.code);});}
  }
  return {
    ready,
    get,
    close:index.close,
    metrics:()=>({writeQueues:queues.size}),
    async list(){
      const works=await all();
      return works.filter(work=>work&&!work.deletedAt&&(work.status||'published')==='published').sort((a,b)=>b.created-a.created);
    },
    async listByAuthor(authorId,{includeUnowned=false}={}){
      await ready;assert(typeof authorId==='string'&&authorId.startsWith('user-'),'用户编号不正确。');
      const works=await all();
      return works.filter(work=>work&&!work.deletedAt&&(work.authorId===authorId||(includeUnowned&&!work.authorId&&work.status!=='withdrawn'))).sort((a,b)=>b.created-a.created);
    },
    async listByStatus(status){
      await ready;assert(['pending','rejected','published','withdrawn'].includes(status),'作品状态不支持。');
      const works=await all();
      return works.filter(work=>work&&!work.deletedAt&&(work.status||'published')===status).sort((a,b)=>b.created-a.created);
    },
    async statsByAuthor(){
      await ready;
      const stats=new Map();
      for(const work of await all()){
        if(!work?.authorId)continue;
        const item=stats.get(work.authorId)||{total:0,published:0,pending:0,draft:0,rejected:0,withdrawn:0,deleted:0};
        if(work.deletedAt)item.deleted++;
        else{
          item.total++;
          const status=work.status||'published';
          if(['published','pending','draft','rejected','withdrawn'].includes(status))item[status]++;
          else item.published++;
        }
        stats.set(work.authorId,item);
      }
      return stats;
    },
    async review(id,{decision,note,expectedRevision,verifyActor}={}){
      await ready;assert(decision==='approve'||decision==='reject','审核操作不支持。');
      assert(Number.isInteger(expectedRevision)&&expectedRevision>=1,'请提供已查看的作品版本。');
      return serial(id,async()=>{
        if(verifyActor)await verifyActor();
        const existing=await get(id);assert(existing,'作品不存在。',404);
        assert(!existing.deletedAt,'作品已移除，无法审核。',409);
        assert(existing.revision===expectedRevision,'作品已更新，请重新查看内容后审核。',409);
        assert((existing.status||'published')==='pending','该作品当前不在待审核状态。',409);
        let reviewNote=null;
        if(decision==='reject'){
          assert(typeof note==='string'&&note.trim().length>0&&note.trim().length<=200,'请填写 200 字以内的未通过原因。');
          reviewNote=note.trim();
        }
        const work={...existing,status:decision==='approve'?'published':'rejected',reviewNote,reviewedAt:Date.now(),revision:existing.revision+1,updated:Date.now(),requestId:null};
        await commit(work);return work;
      });
    },
    async save(metadata,files,actor){
      await ready;assert(metadata&&typeof metadata==='object'&&!Array.isArray(metadata),'作品信息格式不正确。');
      const id=metadata.id;assert(workId.test(id),'作品编号不正确。');
      assert(Number.isInteger(metadata.revision)&&metadata.revision>=0,'作品版本不正确。');
      assert(typeof metadata.requestId==='string'&&/^[0-9a-f-]{36}$/.test(metadata.requestId),'请求编号不正确。');
      assert(metadata.intent===undefined||['draft','submit','withdrawn'].includes(metadata.intent),'保存操作不支持。');
      const isDraft=metadata.intent==='draft';
      const isWithdrawn=metadata.intent==='withdrawn';
      const title=cleanText(metadata.title,'作品名称',70,!isDraft)||'未命名作品',prompt=cleanText(metadata.prompt,'提示词',8000,!isDraft);
      const model=cleanText(metadata.model,'模型名称',40,true),category=cleanText(metadata.category,'风格分类',30,true),ratio=cleanText(metadata.ratio,'画面比例',10,true);
      assert(['image','video'].includes(metadata.type),'请选择图片或视频类型。');
      assert(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(ratio),'画面比例不支持。');
      const manifest=metadata.media;assert(Array.isArray(manifest)&&manifest.length<=limits.count,`每件作品最多 ${limits.count} 个附件。`);
      assert(files.length<=limits.count,'附件数量过多。');
      const source=actor?.importSource;
      if(source){
        assert(source.platform==='x'&&/^[A-Za-z0-9_]{1,15}$/.test(source.account)&&/^\d{10,25}$/.test(source.tweetId),'导入来源不正确。');
        assert(source.url===`https://x.com/${source.account}/status/${source.tweetId}`,'导入来源网址不正确。');
      }
      // File decoding and staging are independent of the metadata commit queue.
      const prepared=[];let preparedTotal=0;
      for(const file of files){
        assert(file&&(typeof file.arrayBuffer==='function'||file.tempPath)&&file.size>0,'不能上传空文件。');
        assert(file.size<=limits.video,'单个文件过大。',413);
        preparedTotal+=file.size;assert(preparedTotal<=limits.total,'每件作品附件总大小不能超过 200 MB。',413);
        let bytes;
        if(file.tempPath){const handle=await open(file.tempPath,'r');try{bytes=Buffer.alloc(Math.min(file.size,256));await handle.read(bytes,0,bytes.length,0);}finally{await handle.close();}}
        else bytes=Buffer.from(await file.arrayBuffer());
        const format=identify(bytes),size=file.tempPath?(await stat(file.tempPath)).size:bytes.length;
        assert(format,'仅支持有效的 JPEG、PNG、WebP、GIF、MP4 或 WebM 文件。',415);
        assert(!file.type||file.type==='application/octet-stream'||file.type===format.mime,'文件内容与格式不一致。',415);
        assert(size===file.size&&size<=limits[format.type],`${format.type==='image'?'图片最大 20':'视频最大 100'} MB。`,413);
        const name=`${randomUUID()}.${format.ext}`;
        prepared.push({name,bytes,tempPath:file.tempPath,media:{id:name,url:`/media/${name}`,type:format.type,mime:format.mime,name:String(file.name||'作品附件').slice(0,180),size,hash:file.hash||createHash('sha256').update(bytes).digest('hex')}});
      }
      const written=[];let committed=false;
      try{
        for(const file of prepared){written.push(file.name);if(file.tempPath)await copyFile(file.tempPath,join(mediaDir,file.name),constants.COPYFILE_EXCL);else await writeFile(join(mediaDir,file.name),file.bytes,{flag:'wx'});file.bytes=null;}
      return await serial(id,async()=>{
        const existing=await get(id);
        assert(existing?.status!=='withdrawn'||existing.authorId===actor?.id,'下架作品仅创作者本人可以操作。',403);
        assert(!isWithdrawn||existing?.status==='withdrawn','只能保存已下架作品的修改。',409);
        assert(!isDraft||!existing||existing.status==='draft','已有提交作品不能直接改为草稿。',409);
        if(existing?.requestId===metadata.requestId)return existing;
        assert(!existing?.deletedAt,'作品已移除，请先恢复作品。',409);
        assert((existing?.revision||0)===metadata.revision,'作品已在其他页面更新，请关闭编辑器并刷新后重试。',409);
        const used=new Set(),attachments=[];let total=0;
        // Validate retained references and the complete manifest before committing metadata.
        for(const item of manifest){
          assert(item&&typeof item==='object','附件信息不正确。');
          if(typeof item.existing==='string'){
            const media=existing?.media.find(m=>m.id===item.existing);
            assert(media&&!used.has('e:'+media.id),'保留的附件不存在或重复。');
            used.add('e:'+media.id);attachments.push(media);total+=media.size;
          }else{
            assert(Number.isInteger(item.file)&&item.file>=0&&item.file<files.length&&!used.has('f:'+item.file),'上传附件不完整或重复。');
            used.add('f:'+item.file);const file=prepared[item.file];
            attachments.push(file.media);total+=file.media.size;
          }
        }
        assert(used.size===manifest.length&&[...used].filter(key=>key.startsWith('f:')).length===files.length,'上传文件与附件列表不一致。');
        assert(total<=limits.total,'每件作品附件总大小不能超过 200 MB。',413);
        {
          // 用户上传的作品一律先进入待审核；修改会重新进入审核。
          // 管理员代编辑他人作品时保留原作者归属；无归属的历史作品被登录用户编辑时沿用“采纳”行为。
          const preserved=!!(existing?.authorId&&actor&&existing.authorId!==actor.id);
          const generationMediaIds=attachments.filter((media,index)=>existing?.generationMediaIds?.includes(media.id)||actor?.generation?.indexes.includes(manifest[index].file)).map(media=>media.id);
          const work={id,title,prompt,model,category,ratio,type:attachments.some(m=>m.type==='video')?'video':attachments.length?'image':metadata.type,media:attachments,
            ...(actor?.generation?.modelId||existing?.modelId?{modelId:actor?.generation?.modelId||existing.modelId}:{}),
            ...(existing?.source||source?{source:existing?.source||source}:{}),
            historyMediaIds:[...new Set([...(existing?.historyMediaIds||[]),...(existing?.media||[]).map(item=>item.id)])],
            revision:(existing?.revision||0)+1,requestId:metadata.requestId,custom:true,uploaded:true,tags:[category],likes:0,
            status:source?'published':isDraft?'draft':isWithdrawn?'withdrawn':'pending',reviewNote:null,reviewedAt:source?Date.now():null,
            generationId:generationMediaIds.length?(existing?.generationId||actor?.generation?.id||null):null,generationMediaIds,
            withdrawnAt:isWithdrawn?existing.withdrawnAt:null,withdrawnBy:isWithdrawn?existing.withdrawnBy:null,
            withdrawnNote:isWithdrawn?(existing.withdrawnNote||null):null,
            privateMediaIds:[...new Set([...(existing?.privateMediaIds||[]),...(isWithdrawn?attachments.map(item=>item.id):[])])].filter(name=>isWithdrawn||!attachments.some(item=>item.id===name)),
            draftMediaIds:[...new Set([...(existing?.draftMediaIds||[]),...(isDraft?attachments.map(item=>item.id):[])])].filter(name=>isDraft||!attachments.some(item=>item.id===name)),
            authorId:preserved?existing.authorId:(actor?.id||existing?.authorId||null),author:preserved?existing.author:(actor?.nickname||existing?.author||'我的作品'),
            subtitle:attachments.length?`${attachments.filter(m=>m.type==='image').length} 张图片 · ${attachments.filter(m=>m.type==='video').length} 个视频`:'我的原创提示词',
            created:existing?.created||(source&&Number.isFinite(actor.importCreated)?actor.importCreated:Date.now()),updated:Date.now(),color:'#a6b3c5'};
          await commit(work);committed=true;return work;
        }
      });
      }finally{if(!committed)await Promise.all(written.map(name=>unlink(join(mediaDir,name)).catch(error=>{if(error.code!=='ENOENT')console.warn('storage: 附件回滚失败',error.code);})));
      }
    },
    async withdraw(id,revision,actorId,{note,requireNote=false}={}){
      await ready;assert(Number.isInteger(revision)&&revision>=0,'作品版本不正确。');
      if(requireNote)assert(typeof note==='string'&&note.trim().length>0&&note.trim().length<=200,'请填写 200 字以内的下架原因。');
      return serial(id,async()=>{
        const existing=await get(id);assert(existing,'作品不存在。',404);
        assert(existing.status!=='withdrawn'||existing.authorId===actorId,'下架作品仅创作者本人可以操作。',403);
        assert(!existing.deletedAt,'作品已删除，无法下架。',409);
        assert(existing.revision===revision,'作品已更新，请刷新后重试。',409);
        if(existing.status==='withdrawn')return existing;
        assert(existing.status!=='draft','发布草稿尚未发布，无需下架。',409);
        const now=Date.now();
        const work={...existing,status:'withdrawn',withdrawnAt:now,withdrawnBy:actorId,withdrawnNote:requireNote?note.trim():null,revision:existing.revision+1,updated:now,requestId:null,
          privateMediaIds:[...new Set([...(existing.privateMediaIds||[]),...existing.media.map(item=>item.id)])]};
        await commit(work);return work;
      });
    },
    async setDeleted(id,deleted,revision,actorId,{allowDeletedAuthor=false}={}){
      await ready;return serial(id,async()=>{
        const existing=await get(id);assert(existing,'作品不存在。',404);
        assert(existing.status!=='withdrawn'||existing.authorId===actorId||allowDeletedAuthor,'下架作品仅创作者本人可以操作。',403);
        assert(existing.revision===revision,'作品已更新，请刷新后重试。',409);
        const work={...existing,revision:existing.revision+1,updated:Date.now(),deletedAt:deleted?Date.now():null,requestId:null};
        await commit(work);return work;
      });
    },
    async media(name){
      assert(mediaId.test(name),'附件不存在。',404);const path=join(mediaDir,name);
      try{
        const info=await stat(path);assert(info.isFile(),'附件不存在。',404);
        await ready;
        const owners=await index.owners(name);
        assert(owners?.size,'附件不存在。',404);
        // Re-read only owners: a corrupt or unreadable owner can never be hidden by a cached public state.
        const works=await Promise.all([...owners].map(get));
        assert(works.every(Boolean),'附件不存在。',404);
        assert(works.every(work=>work.media?.some(item=>item.id===name)||work.historyMediaIds?.includes(name)||work.privateMediaIds?.includes(name)||work.draftMediaIds?.includes(name)),'附件不存在。',404);
        const publicMedia=works.every(work=>!work.deletedAt&&(work.status||'published')==='published'&&!work.privateMediaIds?.includes(name)&&!work.draftMediaIds?.includes(name));
        return {path,size:info.size,mtimeMs:info.mtimeMs,private:!publicMedia,privateOwnerIds:works.map(work=>work.authorId).filter(Boolean)};
      }
      catch(error){if(error.code==='ENOENT')throw new HttpError(404,'附件不存在。');throw error;}
    }
  };
}
