import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('actual session functions clear private state and reject late responses in both completion orders',async()=>{
  for(const late of [true,false]){
    const dialogs=new Map(),privateWork={id:'work-private',uploaded:true,authorId:'author',status:'pending',prompt:'PRIVATE_SENTINEL'};
    const state={user:{id:'admin',role:'admin'},drafts:[],generations:[privateWork],myWorks:[privateWork],userWorks:[privateWork],reviewPending:[privateWork],reviewRejected:[privateWork],creatorPending:[{id:'creator'}],works:[]};
    let release;
    const response=new Promise(resolve=>release=resolve);
    const context={state,prompts:[],workMap:new Map(),workMapSources:[],sessionEpoch:0,detailSeq:0,pageSeq:0,generationSeq:0,gallerySeq:0,galleryKey:'private',galleryLoading:true,galleryHistory:['private'],galleryCursor:'private',galleryCurrentCursor:'private',galleryTotal:5,userCursor:'private',userHistory:['private'],userCurrentCursor:'private',currentPrompt:privateWork,editingRecord:privateWork,editingId:'private',removedDraft:privateWork,lastSubmission:privateWork,invalidateWorkReads(){},
      $(selector){if(!dialogs.has(selector))dialogs.set(selector,{open:false,innerHTML:'PRIVATE_SENTINEL',hidden:false});return dialogs.get(selector);},fetch:()=>response};
    runInNewContext(extract('function findWork(id){','const SOCIAL_PLATFORMS')+extract('function clearPrivateSession(){','function invalidateWorkReads()')+extract('async function requestJson(url,options={}){','async function loadSession()'),context);
    assert.equal(context.findWork('work-private').prompt,'PRIVATE_SENTINEL');
    const reading=context.requestJson('/api/works/work-private');
    if(late){context.clearPrivateSession();state.user=null;release({ok:true,json:async()=>({work:privateWork})});await assert.rejects(reading,{status:409});}
    else{release({ok:true,json:async()=>({work:privateWork})});assert.equal((await reading).work.prompt,'PRIVATE_SENTINEL');context.clearPrivateSession();state.user=null;}
    assert.equal(context.findWork('work-private'),undefined);
    for(const key of ['myWorks','generations','reviewPending','reviewRejected','creatorPending','userWorks'])assert.equal(state[key].length,0);
    assert.equal(context.currentPrompt,null);assert.equal(context.editingRecord,null);assert.equal(context.galleryTotal,0);
    assert.equal(dialogs.get('#detail').innerHTML,'');assert.equal(dialogs.get('#page-view').innerHTML,'');
  }
});
