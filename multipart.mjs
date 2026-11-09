import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, limits } from './storage.mjs';

// Publisher fields only; file bodies are streamed into isolated temporary files.
export async function readMultipart(req) {
  const match=/^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i.exec(req.headers['content-type']||'');
  const boundary=match?.[1]||match?.[2];
  if(!boundary||boundary.length>200)throw new HttpError(400,'上传边界不正确。');
  const directory=await mkdtemp(join(tmpdir(),'lumavision-upload-'));
  const cleanup=()=>rm(directory,{recursive:true,force:true});
  const initial=Buffer.from('--'+boundary+'\r\n'),delimiter=Buffer.from('\r\n--'+boundary);
  let buffer=Buffer.alloc(0),phase='initial',part=null,handle=null,total=0,metadata=null;
  const files=[];
  async function write(bytes){
    if(!bytes.length)return;
    part.size+=bytes.length;
    if(part.size>(part.file?limits.video:96000))throw new HttpError(413,'上传字段过大。');
    if(part.file){await handle.writeFile(bytes);part.hash.update(bytes);}
    else part.chunks.push(bytes);
  }
  async function finish(){
    if(part.file){await handle.close();handle=null;files.push({name:part.name,type:part.type,size:part.size,tempPath:part.path,hash:part.hash.digest('hex')});}
    else {try{const raw=Buffer.concat(part.chunks).toString('utf8');if(raw.length>32000)throw Error();metadata=JSON.parse(raw);}catch{throw new HttpError(400,'作品信息不正确。');}}
    part=null;
  }
  try{
    if(Number(req.headers['content-length'])>limits.total+1024**2)throw new HttpError(413,'上传内容过大。');
    for await(const chunk of req){
      total+=chunk.length;if(total>limits.total+1024**2)throw new HttpError(413,'上传内容过大。');
      buffer=Buffer.concat([buffer,chunk]);
      while(true){
        if(phase==='initial'){
          if(buffer.length<initial.length)break;
          if(!buffer.subarray(0,initial.length).equals(initial))throw new HttpError(400,'上传表单不完整。');
          buffer=buffer.subarray(initial.length);phase='headers';
        }else if(phase==='headers'){
          const end=buffer.indexOf('\r\n\r\n');
          if(end<0){if(buffer.length>16384)throw new HttpError(413,'上传表单头过大。');break;}
          if(end>16384)throw new HttpError(413,'上传表单头过大。');
          const headers=buffer.subarray(0,end).toString('utf8');
          const disposition=/^content-disposition:\s*form-data;\s*name="(metadata|files)"(?:;\s*filename="([^"\r\n]*)")?\s*$/im.exec(headers);
          if(!disposition)throw new HttpError(400,'上传字段不正确。');
          const file=disposition[1]==='files';
          if(file&&(disposition[2]===undefined||files.length>=limits.count))throw new HttpError(400,'附件数量或名称不正确。');
          if(!file&&metadata!==null)throw new HttpError(400,'作品信息重复。');
          part={file,name:disposition[2]||'作品附件',type:/^content-type:\s*([^\r\n]+)$/im.exec(headers)?.[1]?.trim()||'',size:0,chunks:[]};
          if(file){part.path=join(directory,randomUUID());part.hash=createHash('sha256');handle=await open(part.path,'wx');}
          buffer=buffer.subarray(end+4);phase='body';
        }else if(phase==='body'){
          const end=buffer.indexOf(delimiter);
          if(end<0){const length=Math.max(0,buffer.length-delimiter.length-2);await write(buffer.subarray(0,length));buffer=buffer.subarray(length);break;}
          if(buffer.length<end+delimiter.length+2)break;
          const suffix=buffer.subarray(end+delimiter.length,end+delimiter.length+2).toString();
          if(suffix!=='--'&&suffix!=='\r\n'){await write(buffer.subarray(0,end+2));buffer=buffer.subarray(end+2);continue;}
          await write(buffer.subarray(0,end));await finish();
          buffer=buffer.subarray(end+delimiter.length+2);phase=suffix==='--'?'done':'headers';
        }else{
          if(buffer.length>2||buffer.length===2&&!buffer.equals(Buffer.from('\r\n')))throw new HttpError(400,'上传表单尾部不正确。');
          break;
        }
      }
    }
    if(phase!=='done'||metadata===null)throw new HttpError(400,'上传中断或表单不完整。');
    return {metadata,files,cleanup};
  }catch(error){await handle?.close().catch(()=>{});await cleanup();throw error;}
}
