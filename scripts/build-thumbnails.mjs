import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDerivatives } from '../derivatives.mjs';

const index = process.argv.indexOf('--data');
if (index < 0 || !process.argv[index + 1]) throw Error('请用 --data 明确指定数据目录。');
const root = resolve(process.argv[index + 1]), widths = [320, 640, 1280];
const names = new Map(), anomalies = [], snapshot = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let works = 0, originalBytes = 0, existing = 0, existingBytes = 0;
for (const name of await readdir(join(root, 'works'))) {
  if (!/^work-[0-9a-f-]{36}\.json$/.test(name)) continue;
  const path = join(root, 'works', name), bytes = await readFile(path);
  snapshot.set(path, hash(bytes));
  let work;
  try { work = JSON.parse(bytes); } catch { anomalies.push({ name, error: 'invalid JSON' }); continue; }
  if (work.status !== 'published' || work.deletedAt) continue;
  works++;
  if (!Array.isArray(work.media)) { anomalies.push({ name, error: 'invalid media array' }); continue; }
  for (const media of work.media) {
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif|mp4|webm)$/.test(media.id)) { anomalies.push({ name, error: 'invalid media id' }); continue; }
    names.set(media.id, { path: join(root, 'media', media.id), type: media.type });
  }
}
for (const name of await readdir(join(root, 'media'))) {
  const path = join(root, 'media', name);
  if ((await stat(path)).isFile()) snapshot.set(path, hash(await readFile(path)));
}
for (const [name, media] of names) {
  try { media.size = (await stat(media.path)).size; if (!media.size) throw Error('empty original'); originalBytes += media.size; }
  catch (error) { anomalies.push({ name, error: error.message }); }
  for (const width of widths) {
    try { const info = await stat(join(root, 'derived-media', name + '.' + width + '.jpg')); if (info.isFile() && info.size > 0) { existing++; existingBytes += info.size; } else anomalies.push({ name, width, error: 'invalid existing derivative' }); }
    catch (error) { if (error.code !== 'ENOENT') anomalies.push({ name, width, error: error.message }); }
  }
}
const missing = names.size * widths.length - existing;
const report = { mode: process.argv.includes('--build') ? 'build' : 'dry-run', scope: 'published non-deleted works', works, originals: names.size, videos: [...names.values()].filter(m => m.type === 'video').length, originalBytes, widths, existing, existingBytes, missing, estimatedAdditionalBytes: missing * 100 * 1024, estimateBasis: '100 KiB per JPEG planning allowance; content-dependent', maximumAdditionalBytes: missing * 2 * 1024 ** 2, anomalies };
if (process.argv.includes('--build')) {
  if (anomalies.length) throw Error('Preflight anomalies: ' + JSON.stringify(anomalies));
  const derivatives = createDerivatives(root);
  report.completed = 0; report.outputBytes = 0; report.failures = [];
  try {
    if (!await derivatives.ready) throw Error('FFmpeg unavailable');
    for (const [name, media] of names) for (const width of widths) {
      try { const file = await derivatives.file(media, name, width); report.outputBytes += file.size; report.completed++; }
      catch (error) { report.failures.push({ name, width, error: error.message }); }
    }
  } finally { derivatives.close(); }
  const changed = [];
  for (const [path, digest] of snapshot) if (hash(await readFile(path)) !== digest) changed.push(path);
  report.integrity = { checked: snapshot.size, changed };
  report.originalsOverwritten = changed.length;
  if (changed.length || report.failures.length) process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
