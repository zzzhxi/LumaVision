import { spawn } from 'node:child_process';
import { mkdir, stat, rename, unlink, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './storage.mjs';

export function createDerivatives(root,{ffmpeg=process.env.LUMA_FFMPEG||resolve(import.meta.dirname,'tools/media/ffmpeg.exe')}={}) {
  const directory=join(root,'derived-media'),jobs=new Map(),waiting=[];
  let active=0,closed=false;
  const ready=Promise.all([mkdir(directory,{recursive:true}),access(ffmpeg).then(()=>true,()=>false)]).then(([,enabled])=>enabled);
  async function run(input,output,width){
    await new Promise((resolveJob,reject)=>{
      const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-max_alloc','134217728','-threads','1','-max_pixels','40000000','-i',input,'-map','0:v:0','-frames:v','1','-an','-sn','-dn','-vf',`scale=w='min(${width},iw)':h=-2`,'-q:v','4','-threads','1','-f','image2','-update','1',output],{windowsHide:true,stdio:['ignore','ignore','ignore']});
      const timer=setTimeout(()=>{child.kill();},15000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);if(code===0)resolveJob();else reject(new HttpError(503,'封面暂时无法生成，请稍后重试。'));});
    });
  }
  function pump(){
    while(active<2&&waiting.length&&!closed){
      const job=waiting.shift();active++;
      job.run().then(job.resolve,job.reject).finally(()=>{active--;jobs.delete(job.key);pump();});
    }
  }
  async function file(media,name,width){
    if(![320,640,1280].includes(width))throw new HttpError(400,'封面尺寸不支持。');
    const key=name+'.'+width+'.jpg',path=join(directory,key);
    async function existing(){try{const info=await stat(path);return info.isFile()&&info.size>0?{path,size:info.size,mtimeMs:info.mtimeMs}:null;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
    const found=await existing();if(found)return found;
    if(!await ready||closed)throw new HttpError(503,'封面工具未配置，请设置 LUMA_FFMPEG。');
    if(!jobs.has(key)){
      if(waiting.length>=100)throw new HttpError(503,'封面处理繁忙，请稍后重试。');
      const promise=new Promise((resolveJob,reject)=>waiting.push({key,resolve:resolveJob,reject,async run(){
        const temp=join(directory,key+'.'+randomUUID()+'.tmp');
        try{await run(media.path,temp,width);const info=await stat(temp);if(!info.size||info.size>2*1024**2)throw new HttpError(503,'封面输出过大。');await rename(temp,path);}
        finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      }}));
      jobs.set(key,promise);pump();
    }
    await jobs.get(key);return existing();
  }
  // 原媒体删除后，同名封面无法再由内容生成，需要一并清理。
  async function remove(name){
    await Promise.all([320,640,1280].map(width=>unlink(join(directory,`${name}.${width}.jpg`)).catch(error=>{if(error.code!=='ENOENT')console.warn('derivatives: 封面清理失败',name,width,error.code);})));
  }
  return {ready,file,remove,metrics:()=>({active,queued:waiting.length}),close(){closed=true;for(const job of waiting.splice(0))job.reject(new HttpError(503,'封面服务已关闭。'));}};
}
