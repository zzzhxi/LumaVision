import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const index=process.argv.indexOf('--data');
if(index<0||!process.argv[index+1])throw Error('请用 --data 指定要只读核验的数据目录。');
const root=resolve(process.argv[index+1]),owners=new Map(),corrupt=[];
for(const name of await readdir(join(root,'works'))){
  if(!/^work-[0-9a-f-]{36}\.json$/.test(name))continue;
  try{
    const work=JSON.parse(await readFile(join(root,'works',name),'utf8'));
    if(!Array.isArray(work.media))throw Error('invalid media');
    for(const id of new Set([...work.media.map(media=>media.id),...(work.historyMediaIds||[]),...(work.privateMediaIds||[]),...(work.draftMediaIds||[])])){
      if(!owners.has(id))owners.set(id,[]);owners.get(id).push({id:work.id,status:work.status||'published',deleted:!!work.deletedAt,current:work.media.some(media=>media.id===id)});
    }
  }catch(error){if(error instanceof SyntaxError||error.message==='invalid media')corrupt.push(name);else throw error;}
}
const unassigned=[],missing=[];let bytes=0,files=0;
const names=await readdir(join(root,'media'));
const nameSet=new Set(names);
for(const name of names){
  const info=await stat(join(root,'media',name));if(!info.isFile())continue;
  files++;bytes+=info.size;
  if(!owners.has(name))unassigned.push({id:name,bytes:info.size,eligibleForDeletion:false,reason:'归属无法核验，需保留期与备份确认'});
}
for(const name of owners.keys())if(!nameSet.has(name))missing.push(name);
async function optionalNames(directory){try{return await readdir(join(root,directory));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
const generatedOwners=new Set(),generatedCorrupt=[];
for(const name of await optionalNames('generations')){
  if(!/^generation-[0-9a-f-]{36}\.json$/.test(name))continue;
  try{const record=JSON.parse(await readFile(join(root,'generations',name),'utf8'));if(!Array.isArray(record.media))throw Error('invalid media');for(const media of record.media)generatedOwners.add(media.id);}
  catch(error){if(error instanceof SyntaxError||error.message==='invalid media')generatedCorrupt.push(name);else throw error;}
}
const generatedNames=await optionalNames('generated-media'),generatedUnassigned=[],derivedUnassigned=[];
let generatedBytes=0,derivedBytes=0;
for(const name of generatedNames){const info=await stat(join(root,'generated-media',name));if(!info.isFile())continue;generatedBytes+=info.size;if(!generatedOwners.has(name))generatedUnassigned.push({id:name,bytes:info.size,eligibleForDeletion:false});}
const derivedNames=await optionalNames('derived-media');
for(const name of derivedNames){const info=await stat(join(root,'derived-media',name));if(!info.isFile())continue;derivedBytes+=info.size;const original=/^(.+)\.(320|640|1280)\.jpg$/.exec(name)?.[1];if(!original||!owners.has(original)&&!generatedOwners.has(original))derivedUnassigned.push({id:name,bytes:info.size,eligibleForDeletion:false});}
const generatedSet=new Set(generatedNames);
console.log(JSON.stringify({mode:'read-only',files,bytes,corruptRecords:corrupt,missing,unassigned,unassignedBytes:unassigned.reduce((sum,item)=>sum+item.bytes,0),generated:{files:generatedNames.length,bytes:generatedBytes,corruptRecords:generatedCorrupt,missing:[...generatedOwners].filter(name=>!generatedSet.has(name)),unassigned:generatedUnassigned},derived:{files:derivedNames.length,bytes:derivedBytes,unassigned:derivedUnassigned},deletionEnabled:false},null,2));
