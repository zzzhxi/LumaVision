import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const origin=process.env.LUMA_SITE_URL,access=process.env.LUMA_SITE_ACCESS;
const expectedEmail=process.env.LUMA_EXPECTED_EMAIL||'email';
assert(origin&&access,'Missing Site URL or access token');
const snapshot=JSON.parse(await readFile('test-results/sites-migration-inventory.json','utf8'));
const records=snapshot.records.filter(r=>r.kind==='work').map(r=>r.value),published=records.filter(w=>!w.deletedAt&&(w.status||'published')==='published');
const fetchSite=(path,options={})=>fetch(origin+path,{...options,headers:{'OAI-Sites-Authorization':'Bearer '+access,...options.headers},redirect:'manual',signal:AbortSignal.timeout(60000)});
const health=await fetchSite('/api/health');assert.equal(health.status,200);assert.equal((await health.json()).email,expectedEmail);
const allResponse=await fetchSite('/api/works');assert.equal(allResponse.status,200);const all=await allResponse.json();
assert.deepEqual(all.works.map(w=>w.id).sort(),published.map(w=>w.id).sort());
const page=await (await fetchSite('/api/works?limit=36&cards=1')).json();assert.equal(page.total,published.length);assert.equal(page.works.length,36);
const next=await(await fetchSite('/api/works?limit=36&cards=1&cursor='+encodeURIComponent(page.nextCursor))).json();assert.equal(next.works.length,36);assert.equal(new Set([...page.works,...next.works].map(w=>w.id)).size,72);
for(const w of records.filter(w=>!published.some(p=>p.id===w.id))){const response=await fetchSite('/api/works/'+w.id);assert.equal(response.status,404);await response.body.cancel();}
for(const path of ['/api/auth/google/start','/api/auth/google/callback','/api/_migration/status','/mail.local.json','/task_plan.md','/data/auth/users.json']){const r=await fetchSite(path);assert.equal(r.status,404,path);await r.body.cancel();}
for(const path of ['/api/user/works','/api/admin/works','/api/user/generations']){const r=await fetchSite(path);assert.equal(r.status,401);await r.body.cancel();}
const me=await(await fetchSite('/api/auth/me')).json();assert.equal(me.user,null);assert.equal(me.googleEnabled,undefined);assert.equal(me.emailDelivery,expectedEmail);
const privateMedia=new Set();for(const w of records.filter(w=>w.deletedAt||(w.status||'published')!=='published'))for(const media of w.media)privateMedia.add(media.id);
const videoIds=[...new Set(published.flatMap(w=>w.media.filter(m=>m.type==='video').map(m=>m.id)))];
const imageIds=[...new Set(published.flatMap(w=>w.media.filter(m=>m.type==='image').map(m=>m.id)))].slice(0,6);
const probes=[...videoIds,...imageIds,...privateMedia];let nextProbe=0,rangeChecks=0,privateChecks=0;
await Promise.all(Array.from({length:4},async()=>{while(nextProbe<probes.length){const id=probes[nextProbe++],r=await fetchSite('/media/'+id,{headers:{Range:'bytes=0-31'}});if(privateMedia.has(id)){assert.equal(r.status,404,id);await r.body.cancel();privateChecks++;}else{assert.equal(r.status,206,id);assert.equal((await r.arrayBuffer()).byteLength,32);rangeChecks++;}}}));
const sample=published.find(w=>w.media.some(m=>m.type==='image'&&m.thumbnailSmall)).media.find(m=>m.type==='image'&&m.thumbnailSmall);
const original=await fetchSite('/media/'+sample.id);assert.equal(original.status,200);const hash=createHash('sha256').update(Buffer.from(await original.arrayBuffer())).digest('hex');assert.equal(hash,snapshot.objects.find(o=>o.id==='media/'+sample.id).hash);
for(const width of [320,640,1280]){const r=await fetchSite(`/thumbnails/${sample.id}/${width}.jpg`);assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),snapshot.objects.find(o=>o.id===`thumbnails/${sample.id}/${width}.jpg`).hash);}
const report={date:new Date().toISOString(),url:origin,publishedWorks:published.length,privateOrDeletedWorks:records.length-published.length,paginationDistinct:72,mediaRangeChecks:rangeChecks,privateMediaChecks:privateChecks,originalHashChecks:1,thumbnailHashChecks:3,email:expectedEmail,googleOAuth:'removed',generation:'not connected'};
await writeFile(process.env.LUMA_VERIFICATION_REPORT||'docs/sites-deployment-verification-2026-09-30.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
