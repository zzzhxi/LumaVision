import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { identify, limits, HttpError } from './storage.mjs';
import { createRecordIndex, limitedRead } from './record-index.mjs';
import { withWriteLock } from './write-lock.mjs';

const idRule=/^generation-[0-9a-f-]{36}$/;
const fileRule=/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;
const assert=(condition,message,status=400)=>{if(!condition)throw new HttpError(status,message);};
const text=(value,max)=>{assert(typeof value==='string'&&value.trim().length>0&&value.length<=max,'生成结果信息不完整。');return value.trim();};

// Internal completion sink. HTTP callers cannot supply completed image records.
export function createGenerationStore(root){
  const recordsDir=join(root,'generations'),mediaDir=join(root,'generated-media');
  const index=createRecordIndex(recordsDir,idRule);
  const ready=Promise.all([mkdir(recordsDir,{recursive:true}),mkdir(mediaDir,{recursive:true})]).then(()=>index.snapshot());
  let queue=Promise.resolve();
  async function get(id){
    assert(idRule.test(id),'生成记录编号不正确。');
    try{return JSON.parse(await limitedRead(join(recordsDir,id+'.json')));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  }
  async function list(){
    await ready;return [...(await index.snapshot()).records.values()];
  }
  return {
    ready,get,close:index.close,
    async listByAuthor(authorId){return (await list()).filter(record=>record.authorId===authorId).sort((a,b)=>b.created-a.created);},
    async record(input,files,author){
      await ready;
      assert(author&&/^user-[0-9a-f-]{36}$/.test(author.id),'生成结果缺少账号归属。');
      const id=input.id||'generation-'+randomUUID();assert(idRule.test(id),'生成记录编号不正确。');
      const metadata={id,title:text(input.title,70),prompt:text(input.prompt,8000),model:text(input.model,40),category:text(input.category,30),ratio:text(input.ratio,10),provider:text(input.provider,80),providerResultId:input.providerResultId?text(input.providerResultId,180):null};
      assert(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(metadata.ratio),'画面比例不支持。');
      if(input.modelId)metadata.modelId=text(input.modelId,200);
      if(input.requestId){
        metadata.requestId=text(input.requestId,36);metadata.requestHash=text(input.requestHash,64);
        metadata.width=input.width;metadata.height=input.height;metadata.count=input.count;metadata.negative=input.negative||'';
      }
      assert(Array.isArray(files)&&files.length>0&&files.length<=limits.count,'生成记录需要实际生成图片。');
      const pending=[];let total=0;
      for(const file of files){
        assert(file?.size>0&&file.size<=limits.image&&typeof file.arrayBuffer==='function','生成图片为空或过大。',413);
        const bytes=Buffer.from(await file.arrayBuffer()),format=identify(bytes);
        assert(format?.type==='image'&&(!file.type||file.type===format.mime),'生成结果必须是有效图片。',415);
        total+=bytes.length;assert(total<=limits.total,'生成图片总大小超出限制。',413);
        const name=randomUUID()+'.'+format.ext;
        pending.push({bytes,media:{id:name,url:'/generation-media/'+name,type:'image',mime:format.mime,name:String(file.name||'生成图片').slice(0,180),size:bytes.length}});
      }
      const save=async()=>{
        assert(!await get(id),'生成记录已存在。',409);
        const written=[],temp=join(recordsDir,id+'.tmp');
        try{
          for(const item of pending){await writeFile(join(mediaDir,item.media.id),item.bytes,{flag:'wx'});written.push(item.media.id);}
          const created=Date.now(),record={...metadata,generated:true,type:'image',status:'succeeded',authorId:author.id,author:author.nickname,media:pending.map(item=>item.media),tags:[metadata.category],likes:0,subtitle:'创作台生成图片',created,updated:created,color:'#a6b3c5'};
          await writeFile(temp,JSON.stringify(record,null,2),{flag:'wx'});await rename(temp,join(recordsDir,id+'.json'));index.upsert(record);
          return record;
        }catch(error){await Promise.all(written.map(name=>unlink(join(mediaDir,name))));throw error;}
        finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      };
      const next=queue.then(()=>withWriteLock(root,id,save));queue=next.catch(()=>{});return next;
    },
    async imageFile(media){
      assert(fileRule.test(media.id),'生成图片不存在。',404);
      return new File([await readFile(join(mediaDir,media.id))],media.name,{type:media.mime});
    },
    // 仅记录作者可以删除；先移除记录，再清理原图，避免记录指向已删除的文件。
    async remove(id,authorId){
      await ready;
      assert(idRule.test(id),'生成记录编号不正确。');
      return withWriteLock(root,id,async()=>{
        const record=await get(id);
        assert(record,'生成记录不存在。',404);
        assert(record.authorId===authorId,'生成记录不存在。',404);
        try{await unlink(join(recordsDir,id+'.json'));}
        catch(error){if(error.code==='ENOENT')throw new HttpError(404,'生成记录不存在。');throw error;}
        index.invalidate();
        await Promise.all(record.media.map(media=>unlink(join(mediaDir,media.id)).catch(error=>{if(error.code!=='ENOENT')console.warn('generations: 生成图片清理失败',media.id,error.code);})));
        return record;
      });
    },
    async media(name){
      assert(fileRule.test(name),'生成图片不存在。',404);
      await ready;
      const owners=await index.owners(name);
      assert(owners?.size===1,'生成图片不存在。',404);
      const record=await get([...owners][0]);
      assert(record?.media?.some(media=>media.id===name),'生成图片不存在。',404);
      const path=join(mediaDir,name),info=await stat(path);
      return {path,size:info.size,authorId:record.authorId};
    }
  };
}
