import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('thumbnail dry-run selects only live published media and performs no storage writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'luma-thumbnail-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'works')); await mkdir(join(root, 'media'));
  const records = [];
  for (const [status, deletedAt] of [['published', null], ['pending', null], ['withdrawn', null], ['published', '2026-09-17']]) {
    const id = randomUUID() + '.jpg', path = join(root, 'works', 'work-' + randomUUID() + '.json');
    const bytes = JSON.stringify({ status, deletedAt, media: [{ id, type: 'image' }] });
    await writeFile(path, bytes); await writeFile(join(root, 'media', id), 'original fixture');
    records.push({ path, bytes });
  }
  const script = new URL('../scripts/build-thumbnails.mjs', import.meta.url);
  const report = JSON.parse((await run(process.execPath, [script.pathname.replace(/^\/(\w:)/, '$1'), '--data', root])).stdout);
  assert.equal(report.works, 1); assert.equal(report.originals, 1); assert.equal(report.missing, 3);
  assert.deepEqual(report.anomalies, []);
  assert.deepEqual((await readdir(root)).sort(), ['media', 'works']);
  for (const { path, bytes } of records) assert.equal(await readFile(path, 'utf8'), bytes);
});
