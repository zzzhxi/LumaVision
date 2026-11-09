import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// All cooperating writers share these exclusive files; crash locks fail closed.
export async function withWriteLock(root,key,operation) {
  const directory=join(root,'.write-locks');await mkdir(directory,{recursive:true});
  const path=join(directory,key+'.lock'),deadline=Date.now()+2000;
  let handle;
  while(!handle){
    try{handle=await open(path,'wx');}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      if(Date.now()>=deadline){const busy=new Error('记录正在写入或存在中断锁，请稍后重试。');busy.status=503;throw busy;}
      await delay(25);
    }
  }
  try{await handle.writeFile(JSON.stringify({pid:process.pid,created:Date.now()}));return await operation();}
  finally{
    await handle.close().catch(error=>console.warn('storage: 写入锁关闭失败',error.code));
    await unlink(path).catch(error=>{if(error.code!=='ENOENT')console.warn('storage: 写入锁释放失败',error.code);});
  }
}
