import { createHash } from 'node:crypto';
import { HttpError } from './storage.mjs';

export function queryWorks(works, params) {
  const q=(params.get('q')||'').toLowerCase().trim(),type=params.get('type')||'all',category=params.get('category')||'all',model=params.get('model')||'all';
  const status=params.get('workStatus')||'all',sort=params.get('sort')||'newest',ids=params.has('ids')?new Set(params.get('ids').split(',')):null;
  if(q.length>500||params.toString().length>20000)throw new HttpError(400,'查询条件过长。');
  const words=q.split(/\s+/).filter(Boolean);
  const filtered=works.filter(work=>(!ids||ids.has(work.id))&&(type==='all'||work.media.some(media=>media.type===type)||(!work.media.length&&work.type===type))&&(category==='all'||work.category===category||work.tags?.includes(category))&&(model==='all'||work.model===model)&&(status==='all'||(status==='visible'?work.status!=='withdrawn':work.status===status))&&words.every(word=>[work.title,work.subtitle,work.prompt,work.category,work.model,...(work.tags||[])].join(' ').toLowerCase().includes(word)));
  const key=work=>sort==='popular'?Number(work.likes||0):sort==='updated'?Number(work.updated||work.created||0):Number(work.created||0);
  filtered.sort((a,b)=>key(b)-key(a)||b.id.localeCompare(a.id));
  const limit=Number(params.get('limit')||36);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new HttpError(400,'每页数量需为 1-100。');
  const signature=createHash('sha256').update(JSON.stringify({q,type,category,model,status,sort,ids:ids?[...ids]:null})).digest('hex');
  const version=createHash('sha256').update(filtered.map(work=>`${work.id}:${work.revision}:${work.updated}`).join('|')).digest('hex');
  let offset=0;
  if(params.has('cursor')){
    let cursor;try{cursor=JSON.parse(Buffer.from(params.get('cursor'),'base64url').toString());}catch{throw new HttpError(400,'翻页游标不正确。');}
    if(cursor.signature!==signature||cursor.version!==version)throw new HttpError(409,'列表已更新，请重新加载。');
    const index=filtered.findIndex(work=>work.id===cursor.id);
    if(index<0)throw new HttpError(400,'翻页游标不正确。');
    offset=index+1;
  }
  const page=filtered.slice(offset,offset+limit),last=page.at(-1);
  const nextCursor=offset+limit<filtered.length?Buffer.from(JSON.stringify({signature,version,id:last.id})).toString('base64url'):null;
  return {works:page,total:filtered.length,nextCursor};
}

export function workCard(work) {
  const fields=['id','title','subtitle','model','category','ratio','type','status','revision','authorId','author','created','updated','likes','tags','color','custom','uploaded','generated','generationId','reviewNote','withdrawnNote'];
  const card=Object.fromEntries(fields.map(key=>[key,work[key]]));
  return {...card,cardOnly:true,media:work.media.slice(0,1),mediaCount:work.media.length,mediaTypes:[...new Set(work.media.map(media=>media.type))]};
}
