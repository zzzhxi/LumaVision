import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';

const run=promisify(execFile),sizes=process.argv.slice(2).map(Number);
if(!sizes.length)sizes.push(1,5);
if(sizes.some(size=>![1,5].includes(size)))throw Error('用法：node scripts/benchmark-import.mjs [1] [5]；最多约 10 GiB 临时空间。');
const original=await readFile(new URL('../assets/aurora.jpg',import.meta.url)),bytes=Buffer.alloc(16*1024**2);original.copy(bytes);
for(const gib of sizes){
  const root=await mkdtemp(join(tmpdir(),'lumavision-import-benchmark-')),source=join(root,'organized'),data=join(root,'data'),count=gib*64;
  try{
    for(let i=0;i<count;i++){
      const id=String(1234567890123+i),folder=join(source,'20260916_'+id);await mkdir(folder,{recursive:true});
      await writeFile(join(folder,'image.jpg'),bytes);
      await writeFile(join(folder,'prompt.txt'),'合成容量样本\n提示词：a detailed synthetic landscape');
      await writeFile(join(folder,'tweet.json'),JSON.stringify({author:{name:'benchmark'},content:'合成容量样本',date:'2026-09-16 09:00:00'}));
    }
    const args=[fileURLToPath(new URL('./import-twitter-works.mjs',import.meta.url)),'--source',source,'--data',data,'--account','benchmark','--nickname','合成容量作者'];
    const start=performance.now(),dry=JSON.parse((await run(process.execPath,args,{maxBuffer:1024**2})).stdout),dryMs=performance.now()-start;
    const publishStart=performance.now(),published=JSON.parse((await run(process.execPath,[...args,'--publish'],{maxBuffer:1024**2})).stdout);
    if(published.created!==count||published.verified.media!==count||published.bytes!==gib*1024**3)throw Error('导入数量或字节不匹配');
    console.log(JSON.stringify({node:process.version,platform:process.platform,gib,records:count,mediaBytes:published.bytes,perWorkBytes:bytes.length,concurrency:1,dryMs,dryPeakRssBytes:dry.peakRssBytes,publishMs:performance.now()-publishStart,publishPeakRssBytes:published.peakRssBytes,scope:'synthetic JPEG with trailing padding; validates ingestion/hash/persistence, excludes decoding and HTTP'}));
  }finally{await rm(root,{recursive:true,force:true});}
}
