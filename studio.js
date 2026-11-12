export const studioTabs={drafts:'草稿',generations:'生成记录',submissions:'我的投稿'};

export function studioItems({tab,drafts,generations,works,userId}){
  if(tab==='drafts')return drafts;
  if(!userId)return [];
  const results=generations.filter(item=>item.authorId===userId&&item.generated===true&&item.status==='succeeded'&&item.type==='image'&&item.media?.length);
  if(tab==='generations')return results;
  const ids=new Set(results.map(item=>item.id));
  return works.filter(work=>work.authorId===userId&&work.uploaded&&work.status==='published'&&work.type==='image'&&ids.has(work.generationId)&&work.generationMediaIds?.length&&work.media?.length);
}
