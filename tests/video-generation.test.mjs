import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';

const key = 'offline-video-key';
const adminConfig = '/api/admin/video-generation-config';
const jobs = '/api/video-jobs';
const video = await readFile(new URL('./fixtures/flower.webm', import.meta.url));
const picture = await readFile(new URL('../assets/aurora.jpg', import.meta.url));
const metadata = (overrides = {}) => ({ requestId: randomUUID(), title: '测试视频', prompt: '一座安静的海岛', category: '自然风光', ratio: '4:3', duration: 5, ...overrides });

async function setup(t, handler, { waitMs = 2000 } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'luma-video-test-'));
  const calls = [];
  const options = { storageRoot, videoPollMs: 15, videoWaitMs: waitMs, videoFetch: async (url, options) => {
    calls.push(String(url));
    assert.equal(options.headers.Authorization, 'Bearer ' + key);
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'muse-video' }] });
    return handler(String(url), options);
  } };
  let app, base;
  async function start() {
    app = await createApp(options);
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    base = 'http://127.0.0.1:' + app.server.address().port;
  }
  const stop = () => new Promise(done => app.server.close(done));
  await start();
  t.after(async () => { await stop(); await rm(storageRoot, { recursive: true, force: true }); });
  const cookies = {};
  for (const name of ['admin', 'member']) {
    const user = await app.auth.upsertByEmail(name + '@video.test', { nickname: name });
    cookies[name] = 'luma_session=' + (await app.auth.createSession(user.id)).token;
  }
  async function http(path, { actor = 'admin', method = 'GET', body, headers = {} } = {}) {
    const form = body instanceof FormData;
    return fetch(base + path, { method, headers: { ...(actor ? { cookie: cookies[actor] } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !form ? JSON.stringify(body) : body });
  }
  async function submit(input, withReference = false, actor = 'admin') {
    const body = new FormData();
    body.set('metadata', JSON.stringify(input));
    if (withReference) body.append('files', new File([picture], 'reference.jpg', { type: 'image/jpeg' }));
    const response = await http(jobs, { method: 'POST', body, actor });
    return { status: response.status, ...(await response.json()) };
  }
  async function until(id, status) {
    for (let i = 0; i < 100; i++) {
      const { job } = await (await http(jobs + '/' + id)).json();
      if (job.status === status) return job;
      if (['failed', 'submission_unknown'].includes(job.status)) assert.fail(JSON.stringify(job));
      await delay(15);
    }
    assert.fail('任务未进入 ' + status);
  }
  const configure = (body = { enabled: true, apiKey: key }) => http(adminConfig, { method: 'PUT', body });
  return { http, submit, until, configure, calls, async restart(downtime = 0) { await stop(); await delay(downtime); await start(); } };
}

test('管理员可配置视频，参考图和特殊比例送往 Muse，成片私有且可投稿', async t => {
  let submission;
  const env = await setup(t, async (url, options) => {
    if (url.endsWith('/videos')) {
      submission = JSON.parse(options.body);
      return Response.json({ id: 'task_fixture', status: 'queued', progress: 10 });
    }
    if (url.endsWith('/videos/task_fixture')) return Response.json({ status: 'completed', url: 'http://127.0.0.1:18610/v1/media/result.webm' });
    assert.equal(url, 'http://127.0.0.1:8787/v1/media/result.webm');
    return new Response(video);
  });
  assert.equal((await env.http(adminConfig, { actor: 'member' })).status, 403);
  assert.equal((await env.submit(metadata(), false, 'member')).status, 403);
  assert.equal((await env.submit(metadata())).status, 503);
  assert.equal((await env.configure({ baseUrl: 'http://example.com/v1' })).status, 400);
  const config = await env.configure();
  assert.equal(config.status, 200);
  assert.equal((await config.text()).includes(key), false);
  assert.equal((await env.http('/api/admin/video-generation-test', { method: 'POST', body: {} })).status, 200);
  const input = metadata();
  const accepted = await env.submit(input, true);
  assert.equal(accepted.status, 202);
  const done = await env.until(accepted.job.id, 'succeeded');
  assert.equal((await env.submit(input, true)).job.id, accepted.job.id);
  assert.equal((await env.submit({ ...input, duration: 10 }, true)).status, 409);
  assert.equal(env.calls.filter(url => url.endsWith('/videos')).length, 1);
  assert.equal(submission.model, 'muse-video');
  assert.equal(submission.size, '4:3');
  assert.equal(submission.duration, 5);
  assert.match(submission.extra, /4:3/);
  assert.match(submission.images[0], /^data:image\/jpeg;base64,/);

  const { generations: [record] } = await (await env.http('/api/user/generations')).json();
  assert.equal(record.id, done.generationId);
  assert.equal(record.type, 'video');
  assert.equal(record.media[0].mime, 'video/webm');
  assert.equal((await env.http(record.media[0].url, { actor: 'member' })).status, 404);
  const range = await env.http(record.media[0].url, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), video.subarray(0, 16));

  const body = new FormData();
  body.set('metadata', JSON.stringify({ ...input, id: 'work-' + randomUUID(), revision: 0, type: 'video', model: 'Muse Video', intent: 'submit', generationId: record.id, media: [{ existing: record.media[0].id }] }));
  const result = await env.http('/api/works', { method: 'POST', body });
  assert.equal(result.status, 200, await result.clone().text());
  const { work } = await result.json();
  assert.equal(work.type, 'video');
  assert.equal(work.modelId, 'muse-video');
  assert.equal(work.generationId, record.id);
  assert.equal((await env.http('/api/generations/' + record.id, { method: 'DELETE' })).status, 409);
  body.set('metadata', JSON.stringify({ ...input, requestId: randomUUID(), id: work.id, revision: work.revision, type: 'video',
    model: 'Kling', intent: 'submit', media: [{ existing: work.media[0].id }] }));
  const edit = await env.http('/api/works', { method: 'POST', body });
  assert.equal(edit.status, 200);
  assert.equal((await edit.json()).work.model, 'Muse Video');
});

test('重启后继续查询已接收的视频任务，关闭开关仍可保存成片', async t => {
  let ready = false;
  const env = await setup(t, async url => {
    if (url.endsWith('/videos')) return Response.json({ id: 'task_resume' });
    if (url.endsWith('/videos/task_resume')) return Response.json(ready ? { status: 'completed', result: { url: '/v1/media/result.webm' } } : { status: 'processing', progress: 15 });
    return new Response(video);
  });
  await env.configure();
  const { job } = await env.submit(metadata({ ratio: '9:16', duration: 8 }));
  assert.equal(job.ratio, '9:16');
  assert.equal(job.duration, 8);
  const processing = await env.until(job.id, 'processing');
  assert.equal(processing.progress, 15);
  assert.equal((await env.submit(metadata())).status, 429);
  assert.equal((await env.configure({ enabled: false })).status, 200);
  await env.restart();
  const { jobs: [restored] } = await (await env.http(jobs)).json();
  assert.equal(restored.id, job.id);
  assert.equal(restored.ratio, '9:16');
  assert.equal(restored.duration, 8);
  assert.equal(restored.model, 'Muse Video');
  assert.equal(restored.category, '自然风光');
  assert.equal(restored.created, job.created);
  assert.equal(restored.progress, 15);
  ready = true;
  await env.until(job.id, 'succeeded');
  assert.equal(env.calls.filter(url => url.endsWith('/videos')).length, 1);
  assert.equal((await env.submit(metadata())).status, 503);
});

test('停机超过查询期限时仍保存已完成的任务，并重试临时下载失败', async t => {
  let ready = false, downloads = 0;
  const env = await setup(t, async url => {
    if (url.endsWith('/videos')) return Response.json({ id: 'task_long_restart' });
    if (url.endsWith('/videos/task_long_restart')) return Response.json(ready ? { status: 'completed', url: '/v1/media/result.webm' } : { status: 'processing' });
    if (++downloads === 1) return new Response('temporary', { status: 503 });
    return new Response(video);
  }, { waitMs: 400 });
  await env.configure();
  const { job } = await env.submit(metadata());
  await env.until(job.id, 'processing');
  const restarting = env.restart(450);
  await delay(50);
  ready = true;
  await restarting;
  await env.until(job.id, 'succeeded');
  assert.equal(downloads, 2);
  assert.equal(env.calls.filter(url => url.endsWith('/videos')).length, 1);
});

test('派发中途重启保留待确认状态并拒绝重复派发', async t => {
  const env = await setup(t, async (url, options) => {
    assert.ok(url.endsWith('/videos'));
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  await env.configure();
  const input = metadata();
  const { job } = await env.submit(input, true);
  await env.until(job.id, 'submitting');
  await env.restart();
  const unknown = await env.until(job.id, 'submission_unknown');
  assert.match(unknown.error, /先在 Muse 检查/);
  const replay = await env.submit(input, true);
  assert.equal(replay.job.id, job.id);
  assert.equal(env.calls.filter(url => url.endsWith('/videos')).length, 1);
});

test('五种画幅均发送给 Muse，上游中断与无效成片显示失败', async t => {
  const payloads = [];
  let invalidMedia = null;
  const env = await setup(t, async (url, options) => {
    if (url.endsWith('/videos')) {
      payloads.push(JSON.parse(options.body));
      return Response.json({ id: 'task_aspect_ratio' });
    }
    if (url.endsWith('/videos/task_aspect_ratio')) return Response.json(invalidMedia
      ? { status: 'completed', url: '/v1/media/invalid.mp4' } : { status: 'failed', error: '服务重启中断了任务 ' + key });
    return new Response('not a valid video', invalidMedia === 'size' ? { headers: { 'Content-Length': String(100 * 1024 ** 2 + 1) } } : {});
  });
  await env.configure();
  for (const [ratio, duration] of [['16:9', 5], ['9:16', 6], ['1:1', 8], ['4:3', 10], ['3:4', 5]]) {
    const { job } = await env.submit(metadata({ ratio, duration }));
    const failed = await env.until(job.id, 'failed');
    assert.match(failed.error, /服务重启中断了任务/);
    assert.equal(failed.error.includes(key), false);
    const payload = payloads.at(-1);
    assert.equal(payload.size, ratio);
    assert.equal(payload.duration, duration);
    if (['1:1', '4:3', '3:4'].includes(ratio)) assert.ok(payload.extra.includes(ratio));
    else assert.equal(payload.extra, undefined);
  }
  for (const [mode, message] of [['format', /有效的 MP4 或 WebM/], ['size', /超过 100 MiB/]]) {
    invalidMedia = mode;
    const { job } = await env.submit(metadata());
    assert.match((await env.until(job.id, 'failed')).error, message);
  }
  assert.deepEqual((await (await env.http('/api/user/generations')).json()).generations, []);
});
