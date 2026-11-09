import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from '../storage.mjs';

const run=promisify(execFile),script=fileURLToPath(new URL('../scripts/import-twitter-works.mjs',import.meta.url));
test('CLI import is atomic and repeatable after an author edit, retaining sources and original media',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lumavision-import-regression-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'organized'),data=join(root,'data'),folder=join(source,'20260916_1234567890123');
  await mkdir(folder,{recursive:true});
  const original=await readFile(new URL('../assets/aurora.jpg',import.meta.url));
  await writeFile(join(folder,'image.jpg'),original);
  await writeFile(join(folder,'prompt.txt'),'隔离导入\n提示词：a detailed landscape, 3:4');
  await writeFile(join(folder,'tweet.json'),JSON.stringify({author:{name:'example'},content:'隔离导入',date:'2026-09-16 09:00:00'}));
  const args=[script,'--source',source,'--data',data,'--account','example','--nickname','隔离作者'];
  const dry=JSON.parse((await run(process.execPath,args)).stdout);assert.equal(dry.works,1);
  assert.equal((await readdir(root)).includes('data'),false);
  const published=JSON.parse((await run(process.execPath,[...args,'--publish'])).stdout);
  assert.equal(published.created,1);assert.equal(published.verified.statuses.published,1);
  const store=createStore(data);await store.ready;t.after(()=>store.close());
  const [work]=await store.list();assert.equal(work.source.tweetId,'1234567890123');assert.equal(work.status,'published');
  const edited=await store.save({...work,title:'作者编辑',prompt:'人工保留',requestId:randomUUID(),media:work.media.map(media=>({existing:media.id}))},[],{id:work.authorId,nickname:work.author});
  const repeated=JSON.parse((await run(process.execPath,[...args,'--publish'])).stdout);
  assert.equal(repeated.created,0);assert.equal(repeated.updated,0);assert.equal(repeated.skipped,1);
  const record=JSON.parse(await readFile(join(data,'works',work.id+'.json'),'utf8'));
  assert.equal(record.title,'作者编辑');assert.equal(record.prompt,'人工保留');assert.equal(record.revision,edited.revision);
  assert.deepEqual(record.source,work.source);
  assert.equal((await readdir(join(data,'media'))).length,1);
  assert.deepEqual(await readFile(join(data,'media',work.media[0].id)),original);
  const audit=JSON.parse((await run(process.execPath,[fileURLToPath(new URL('../scripts/audit-media.mjs',import.meta.url)),'--data',data])).stdout);
  assert.equal(audit.files,1);assert.equal(audit.unassigned.length,0);assert.equal(audit.deletionEnabled,false);
  const build=fileURLToPath(new URL('../scripts/build-thumbnails.mjs',import.meta.url));
  assert.equal(JSON.parse((await run(process.execPath,[build,'--data',data])).stdout).originals,0);
  await store.review(edited.id,{decision:'approve',expectedRevision:edited.revision});
  assert.equal(JSON.parse((await run(process.execPath,[build,'--data',data])).stdout).originals,1);
  if(process.env.LUMA_FFMPEG||await access(new URL('../tools/media/ffmpeg.exe',import.meta.url)).then(()=>true,()=>false)){
    await run(process.execPath,[build,'--data',data,'--build']);
    const thumbnails=await readdir(join(data,'derived-media'));assert.equal(thumbnails.length,3);
    const before=await Promise.all(thumbnails.map(name=>readFile(join(data,'derived-media',name))));
    await run(process.execPath,[build,'--data',data,'--build']);
    assert.deepEqual(await Promise.all(thumbnails.map(name=>readFile(join(data,'derived-media',name)))),before);
    assert.deepEqual(await readFile(join(data,'media',work.media[0].id)),original);
  }
});

test('independent Node writers serialize revision checks instead of overwriting each other',async t=>{
  const root=await mkdtemp(join(tmpdir(),'lumavision-writers-')),store=createStore(root);await store.ready;
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const actor={id:'user-'+randomUUID(),nickname:'隔离作者'};
  const work=await store.save({id:'work-'+randomUUID(),revision:0,requestId:randomUUID(),title:'初始',prompt:'提示词',model:'GPT Image',category:'自然风光',ratio:'3:4',type:'image',media:[]},[],actor);
  const moduleUrl=new URL('../storage.mjs',import.meta.url).href;
  const code=`import {createStore} from ${JSON.stringify(moduleUrl)};const store=createStore(process.argv[1]);try{await store.ready;const work=JSON.parse(process.argv[2]);await store.save(work,[],JSON.parse(process.argv[3]));}catch(error){console.error(error.status);process.exitCode=1;}finally{store.close();}`;
  const outcomes=await Promise.allSettled(['甲','乙'].map(title=>run(process.execPath,['--input-type=module','-e',code,root,JSON.stringify({...work,title,requestId:randomUUID(),media:[]}),JSON.stringify(actor)])));
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
  assert.match(outcomes.find(item=>item.status==='rejected').reason.stderr,/409/);
  assert.equal((await store.get(work.id)).revision,2);
  assert.deepEqual(await readdir(join(root,'.write-locks')),[]);
});
