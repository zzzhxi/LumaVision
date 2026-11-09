import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
const root=resolve(import.meta.dirname,'..'),dataRoot=join(root,'data'),mode=process.argv[2]||'inventory';
const hashFile=async path=>{const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');};
const mime={jpg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm'};
async function inventory(){
  if((await readdir(join(dataRoot,'generations'))).filter(n=>n.endsWith('.json')).length)throw new Error('Existing generation records require a dedicated migration; refusing to omit them.');
  const records=[],objects=[],hashes={};
  const thumbs=new Set(await readdir(join(dataRoot,'derived-media')));
  for(const name of (await readdir(join(dataRoot,'works'))).filter(n=>n.endsWith('.json')).sort()){
    const path=join(dataRoot,'works',name),work=JSON.parse(await readFile(path,'utf8'));hashes['works/'+name]=await hashFile(path);
    for(const media of work.media||[]){if([320,640,1280].every(width=>thumbs.has(media.id+'.'+width+'.jpg'))){media.thumbnailUrl='/thumbnails/'+media.id+'/640.jpg';media.thumbnailSmall='/thumbnails/'+media.id+'/320.jpg';media.thumbnailLarge='/thumbnails/'+media.id+'/1280.jpg';}}
    records.push({kind:'work',value:work});
  }
  const usersPath=join(dataRoot,'auth/users.json'),users=Object.values(JSON.parse(await readFile(usersPath,'utf8')).users);hashes['auth/users.json']=await hashFile(usersPath);
  const userFields=['id','email','nickname','social','role','importedAuthor','accountType','onboardingComplete','creatorStatus','creatorNote','creatorRequestedAt','creatorReviewedAt','createdAt','avatarUrl'];
  for(const user of users)records.push({kind:'user',value:Object.fromEntries(userFields.filter(key=>user[key]!==undefined).map(key=>[key,user[key]]))});
  for(const [directory,kind] of [['media','media'],['derived-media','thumbnail']])for(const name of (await readdir(join(dataRoot,directory))).sort()){
    const path=join(dataRoot,directory,name),info=await stat(path);if(!info.isFile())continue;
    const id=kind==='media'?'media/'+name:'thumbnails/'+name.replace(/\.(320|640|1280)\.jpg$/,'/$1.jpg');
    const hash=await hashFile(path);hashes[directory+'/'+name]=hash;
    const object={id,size:info.size,hash,mime:kind==='thumbnail'?'image/jpeg':mime[name.split('.').at(-1)]};
    if(!object.mime)throw new Error('Unrecognized media extension: '+name);
    records.push({kind:'object',value:object});objects.push({...object,path});
  }
  return {records,objects,hashes,summary:{works:records.filter(r=>r.kind==='work').length,users:users.length,admins:users.filter(u=>u.role==='admin'&&!u.importedAuthor).length,objects:objects.length,bytes:objects.reduce((n,o)=>n+o.size,0)}};
}
await mkdir(join(root,'test-results'),{recursive:true});
const snapshotPath=join(root,'test-results/sites-migration-inventory.json');
if(mode==='inventory'){
  const snapshot=await inventory();await writeFile(snapshotPath,JSON.stringify(snapshot));console.log(JSON.stringify(snapshot.summary));
} else if(mode==='verify-local'){
  const before=JSON.parse(await readFile(snapshotPath,'utf8')),after=await inventory();
  if(JSON.stringify(before.hashes)!==JSON.stringify(after.hashes))throw new Error('Local data changed during migration.');console.log(JSON.stringify({unchanged:true,files:Object.keys(after.hashes).length}));
} else {
  const snapshot=JSON.parse(await readFile(snapshotPath,'utf8'));
  const origin=process.env.LUMA_SITE_URL,access=process.env.LUMA_SITE_ACCESS,key=process.env.LUMA_MIGRATION_KEY;
  if(!origin||!access||!key)throw new Error('Missing migration credentials.');
  async function request(path,{method='GET',json,file}={}){
    for(let attempt=0;attempt<4;attempt++){
      const headers={'OAI-Sites-Authorization':'Bearer '+access,Authorization:'Bearer '+key};let body;
      if(json){headers['Content-Type']='application/json';body=JSON.stringify(json);}
      if(file){headers['Content-Type']=file.mime;headers['Content-Length']=String(file.size);body=createReadStream(file.path);}
      try{
        const response=await fetch(origin+path,{method,headers,body,duplex:'half',redirect:'manual',signal:AbortSignal.timeout(120000)});
        if(!response.ok){await response.body?.cancel();if([429,500,502,503,504].includes(response.status)&&attempt<3){await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));continue;}throw new Error('Migration HTTP '+response.status+' at '+path.split('?')[0]);}
        return await response.json();
      }catch(error){body?.destroy?.();if(attempt===3||error.message.startsWith('Migration HTTP'))throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
    }
  }
  if(mode==='migrate'){
    let recordNext=0,recordDone=0;
    await Promise.all(Array.from({length:4},async()=>{while(recordNext<snapshot.records.length){const i=recordNext;recordNext+=20;const records=snapshot.records.slice(i,i+20);await request('/api/_migration/records',{method:'POST',json:{records}});recordDone+=records.length;if(recordDone%200===0||recordDone===snapshot.records.length)console.log('Records '+recordDone+'/'+snapshot.records.length);}}));
  }
  if(mode==='migrate'||mode==='objects'){
    const before=await request('/api/_migration/status');
    if(before.works!==snapshot.summary.works||before.users!==snapshot.summary.users||before.total!==snapshot.summary.objects)throw new Error('Complete metadata migration is required before uploading objects.');
    let next=0,completed=0;
    const concurrency=Math.max(1,Math.min(24,Number(process.env.LUMA_MIGRATION_CONCURRENCY)||6));
    await Promise.all(Array.from({length:concurrency},async()=>{while(next<snapshot.objects.length){const file=snapshot.objects[next++];const result=await request('/api/_migration/object?id='+encodeURIComponent(file.id),{method:'PUT',file});if(result.hash!==file.hash)throw new Error('Remote hash mismatch');completed++;if(completed%50===0)console.log('Verified objects '+completed+'/'+snapshot.objects.length);}}));
  }
  const status=await request('/api/_migration/status');console.log(JSON.stringify(status));
  if((mode==='migrate'||mode==='objects')&&(status.works!==snapshot.summary.works||status.users!==snapshot.summary.users||status.total!==snapshot.summary.objects||status.migrated!==status.total))throw new Error('Migration totals mismatch.');
}
