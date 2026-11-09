const max={count:12,image:20*1024**2,video:100*1024**2,total:200*1024**2};
const allowed=new Set(['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']);
const escape=value=>String(value||'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
export const formatSize=bytes=>bytes>=1024**2?`${(bytes/1024**2).toFixed(1)} MB`:`${Math.ceil(bytes/1024)} KB`;

export function createUploader(host,initial=[]){
  let entries=initial.map(media=>({...media,url:media.file?URL.createObjectURL(media.file):media.url})),locked=false,selecting=false,disposed=false;
  host.innerHTML=`<div class="upload-label"><span>生成的图片 / 视频 <span class="optional">可选</span></span><span id="upload-count"></span></div><div class="drop-zone"><input id="media-input" class="media-input" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" aria-label="上传图片或视频"><span class="upload-symbol" aria-hidden="true">＋</span><strong>把作品拖到这里，或点击上传</strong><span>支持一次选择多张图片，也可以添加视频</span><small>最多 12 个 · 图片 20 MB / 个 · 视频 100 MB / 个 · 合计 200 MB</small></div><p class="upload-error" role="alert" hidden></p><div class="attachment-list"></div><p class="upload-hint">第一项用作封面。支持 JPEG、PNG、WebP、GIF、MP4、WebM。</p>`;
  const input=host.querySelector('input'),list=host.querySelector('.attachment-list'),error=host.querySelector('.upload-error'),zone=host.querySelector('.drop-zone');
  function message(text){error.textContent=text;error.hidden=!text;}
  function render(){
    host.querySelector('#upload-count').textContent=`${entries.length} / 12 · ${formatSize(entries.reduce((n,m)=>n+m.size,0))}`;
    list.innerHTML=entries.map((media,i)=>`<div class="attachment"><div class="attachment-preview">${media.type==='video'?`<video src="${escape(media.url)}#t=0.1" muted playsinline preload="metadata"></video><span class="attachment-video">视频</span>`:`<img src="${escape(media.url)}" alt="附件 ${i+1}：${escape(media.name)}">`}${i===0?'<span class="cover-label">封面</span>':''}</div><div class="attachment-info"><span title="${escape(media.name)}">${escape(media.name)}</span><small>${formatSize(media.size)}</small></div><div class="attachment-actions"><button type="button" data-cover="${i}" ${i===0?'disabled':''} aria-label="将第 ${i+1} 项设为封面">设为封面</button><button type="button" data-left="${i}" ${i===0?'disabled':''} aria-label="将第 ${i+1} 项前移">←</button><button type="button" data-remove="${i}" aria-label="移除第 ${i+1} 个附件">移除</button></div></div>`).join('');
    host.querySelectorAll('button').forEach(button=>button.disabled=locked||selecting||((button.hasAttribute('data-cover')&&button.dataset.cover==='0')||(button.hasAttribute('data-left')&&button.dataset.left==='0')));
    input.disabled=locked||selecting;zone.classList.toggle('is-busy',selecting);
  }
  async function add(files){
    if(locked||selecting||disposed)return;const incoming=[...files];if(!incoming.length)return;
    selecting=true;render();message('');
    const problems=[];
    for(const file of incoming){
      if(entries.length>=max.count){problems.push('每件作品最多 12 个附件。');break;}
      if(!allowed.has(file.type)){problems.push(`${file.name}：格式不支持。`);continue;}
      const type=file.type.startsWith('image/')?'image':'video';
      if(!file.size||file.size>max[type]){problems.push(`${file.name}：${type==='image'?'图片需为 1 字节至 20 MB':'视频需为 1 字节至 100 MB'}。`);continue;}
      if(entries.reduce((n,m)=>n+m.size,0)+file.size>max.total){problems.push('附件总大小不能超过 200 MB。');continue;}
      const url=URL.createObjectURL(file);
      try{
        if(type==='image'){const image=new Image();image.src=url;await image.decode();}
        else if(!document.createElement('video').canPlayType(file.type)){throw new Error('unsupported');}
        if(disposed){URL.revokeObjectURL(url);break;}
        entries.push({file,url,type,name:file.name,size:file.size,mime:file.type});
      }catch{URL.revokeObjectURL(url);problems.push(`${file.name}：无法读取，请选择有效且浏览器支持的媒体文件。`);}
    }
    selecting=false;if(disposed)return;input.value='';render();message(problems.join(' '));
  }
  input.addEventListener('change',()=>add(input.files));
  zone.addEventListener('dragover',event=>{event.preventDefault();if(!locked)zone.classList.add('drag-over');});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',event=>{event.preventDefault();zone.classList.remove('drag-over');add(event.dataTransfer.files);});
  list.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||locked||selecting)return;
    if(button.hasAttribute('data-remove')){const [item]=entries.splice(Number(button.dataset.remove),1);if(item.file)URL.revokeObjectURL(item.url);}
    if(button.hasAttribute('data-cover')){const [item]=entries.splice(Number(button.dataset.cover),1);entries.unshift(item);}
    if(button.hasAttribute('data-left')){const index=Number(button.dataset.left);[entries[index-1],entries[index]]=[entries[index],entries[index-1]];}
    render();message('');
  });
  render();
  return {
    get entries(){return entries;},get busy(){return selecting;},
    setDisabled(value){locked=value;render();},
    // File objects stay in memory only. They are never put in localStorage.
    snapshot(){return entries.map(({url,...entry})=>entry.file?{...entry,url:null}:{...entry,url});},
    dispose(){disposed=true;entries.forEach(entry=>{if(entry.file)URL.revokeObjectURL(entry.url);});},
    build(){const files=[],manifest=entries.map(entry=>entry.file?{file:files.push(entry.file)-1}:{existing:entry.id});return {files,manifest};}
  };
}

export function publishWork(metadata,files,onProgress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),form=new FormData();
    form.append('metadata',JSON.stringify(metadata));files.forEach(file=>form.append('files',file,file.name));
    xhr.open('POST','/api/works');xhr.timeout=300000;
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100));};
    xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{reject(new Error('服务器返回异常，请保留当前内容后重试。'));return;}
      if(xhr.status>=200&&xhr.status<300&&result.work)resolve(result.work);else reject(new Error(result.error||'上传未完成，请重试。'));};
    xhr.onerror=()=>reject(new Error('连接中断。文件仍保留在编辑器中，请重试。'));
    xhr.ontimeout=()=>reject(new Error('上传超时。文件仍保留在编辑器中，请重试。'));
    xhr.send(form);
  });
}
