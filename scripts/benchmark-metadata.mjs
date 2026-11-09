import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStore } from '../storage.mjs';
import { queryWorks } from '../work-query.mjs';

const count=Number(process.argv[2]||10000),concurrency=Number(process.argv[3]||6),samples=100;
if(!Number.isInteger(count)||count<1||count>50000||!Number.isInteger(concurrency)||concurrency<1||concurrency>12)throw Error('用法：node scripts/benchmark-metadata.mjs [1-50000] [1-12]');
const root=await mkdtemp(join(tmpdir(),'lumavision-benchmark-')),store=createStore(root);await store.ready;
try{
  for(let i=0;i<count;i++){
    const id='work-'+randomUUID();await writeFile(join(root,'works',id+'.json'),JSON.stringify({id,title:'synthetic '+i,prompt:'needle '.repeat(50),model:'GPT Image',category:'自然风光',tags:['自然风光'],revision:1,created:i,updated:i,status:'published',media:[]}));
  }
  const start=performance.now(),cold=await Promise.all(Array.from({length:concurrency},()=>store.list()));
  if(cold.some(list=>list.length!==count))throw Error('读取数量错误');
  const coldMs=performance.now()-start,times=[],params=new URLSearchParams({limit:'36',q:'needle'});
  for(let i=0;i<Math.ceil(samples/concurrency);i++)await Promise.all(Array.from({length:concurrency},async()=>{
    const start=performance.now(),works=await store.list(),result=queryWorks(works,params);
    if(result.total!==count||result.works.length!==Math.min(count,36))throw Error('分页结果错误');times.push(performance.now()-start);
  }));
  times.sort((a,b)=>a-b);
  console.log(JSON.stringify({node:process.version,platform:process.platform,records:count,concurrency,samples:times.length,coldConcurrentMs:coldMs,hotP50Ms:times[Math.floor(times.length*.5)],hotP95Ms:times[Math.floor(times.length*.95)],scope:'synthetic metadata only; includes lookup/filter/cursor, excludes HTTP/profile/media',peakRssBytes:process.resourceUsage().maxRSS*1024},null,2));
}finally{store.close();await rm(root,{recursive:true,force:true});}
