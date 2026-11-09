import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// One shared limit across stores and concurrent scans, including direct lookups.
let active = 0;
const waiting = [];
export async function limitedRead(path) {
  if (active >= 16) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try { return await readFile(path, 'utf8'); }
  finally { const next = waiting.shift(); if (next) next(); else active--; }
}

export function createRecordIndex(directory, rule) {
  let records = new Map(), media = new Map(), dirty = true, loading, epoch = 0, watcher, refreshTimer;
  const invalidate = () => {
    dirty = true; epoch++;
    // External writers are observed in the background, never by scanning during media authorization.
    clearTimeout(refreshTimer);
    if(watcher){refreshTimer=setTimeout(()=>snapshot().catch(error=>console.warn('storage: 索引刷新失败',error.code||error.name)),80);refreshTimer.unref();}
  };
  async function snapshot() {
    if (!watcher) {
      watcher = watch(directory, { persistent: false }, invalidate);
      watcher.on('error', () => { watcher?.close(); watcher = null; invalidate(); });
    }
    if (loading) return loading;
    if (!dirty) return { records, media };
    const start = epoch;
    loading = (async () => {
      const names = (await readdir(directory)).filter(name => name.endsWith('.json') && rule.test(name.slice(0, -5)));
      const nextRecords = new Map(), nextMedia = new Map();
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
        while (cursor < names.length) {
          const name = names[cursor++], id = name.slice(0, -5);
          let record;
          try { record = JSON.parse(await limitedRead(join(directory, name))); }
          catch (error) {
            if (error instanceof SyntaxError) { console.warn('storage: 损坏记录', id); continue; }
            if (error.code === 'ENOENT') continue;
            throw error;
          }
          if (!record || record.id !== id || !Array.isArray(record.media)) { console.warn('storage: 无效记录', id); continue; }
          nextRecords.set(id, record);
          const ids = new Set([...(record.media || []).map(item => item.id), ...(record.historyMediaIds || []), ...(record.privateMediaIds || []), ...(record.draftMediaIds || [])]);
          for (const mediaId of ids) {
            if (!nextMedia.has(mediaId)) nextMedia.set(mediaId, new Set());
            nextMedia.get(mediaId).add(id);
          }
        }
      }));
      if(epoch===start){records=nextRecords;media=nextMedia;dirty=false;}
      return { records, media };
    })().then(result=>{if(dirty){loading=null;return snapshot();}return result;});
    try { return await loading; } finally { loading = null; }
  }
  return { snapshot, invalidate,
    owners(name) { return media.get(name); },
    upsert(record){
      records.set(record.id,record);
      for(const name of new Set([...record.media.map(item=>item.id),...(record.historyMediaIds||[]),...(record.privateMediaIds||[]),...(record.draftMediaIds||[])])){
        if(!media.has(name))media.set(name,new Set());media.get(name).add(record.id);
      }
      invalidate();
    },
    close() { clearTimeout(refreshTimer);watcher?.close(); watcher = null; }
  };
}
