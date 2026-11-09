import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { HttpError } from '../storage.mjs';

const parent = resolve('test-results');
await mkdir(parent, { recursive: true });
const picture = await readFile(new URL('../assets/aurora.jpg', import.meta.url));
const modelId = 'test-image-model-with-an-id-longer-than-forty-characters-2026';
const key = 'offline-key-sentinel';
const payload = overrides => ({ requestId: randomUUID(), title: '测试生成', prompt: 'A quiet sea.', negative: '文字', modelId, category: '自然风光', width: 1024, height: 1536, count: 1, ...overrides });
async function setup(t, { timeoutMs = 1000 } = {}) {
  const dir = await mkdtemp(join(parent, 'generation-test-'));
  const calls = [];
  let mode = 'base64', delay = null;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/models')) {
      if (mode === 'auth') return Response.json({ error: { message: 'Bearer ' + key } }, { status: 401 });
      return Response.json({ data: [{ id: modelId }, { id: 'text-model' }] });
    }
    if (String(url).includes('/output')) {
      assert.equal(options.headers, undefined);
      return new Response(picture);
    }
    if (delay) await delay;
    if (mode === 'timeout') return new Promise((_, reject) => {
      const fail = () => reject(new DOMException('timeout', 'TimeoutError'));
      if (options.signal.aborted) fail(); else options.signal.addEventListener('abort', fail, { once: true });
    });
    if (mode === 'network') throw new Error('network failure ' + key);
    if (mode === 'auth') return Response.json({ error: { message: key } }, { status: 401 });
    if (mode === 'rate') return Response.json({ error: { message: 'rate limit' } }, { status: 429 });
    if (mode === 'size') return Response.json({ error: { message: 'unsupported size ' + key } }, { status: 400 });
    if (mode === 'json') return new Response('not-json');
    if (mode === 'empty') return Response.json({ data: [] });
    if (mode === 'invalid') return Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
    if (mode === 'url') return Response.json({ data: [{ url: 'http://image-service.test/output.jpg' }] });
    return Response.json({ data: [{ b64_json: picture.toString('base64') }] }, { headers: { 'x-request-id': 'provider-fixture-id' } });
  };
  const options = { storageRoot: dir, generationFetch: fetchImpl, generationTimeoutMs: timeoutMs, sendAuthCode: async () => ({ delivery: 'email' }) };
  let app = await createApp(options);
  const listen = async () => { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); };
  await listen();
  t.after(async () => { await new Promise(done => app.server.close(done)); assert.ok(dir.startsWith(parent + sep + 'generation-test-')); await rm(dir, { recursive: true, force: true }); });
  const users = {}, cookies = {};
  for (const name of ['admin', 'member', 'other']) {
    users[name] = await app.auth.upsertByEmail(name + '@generation.test', { nickname: name });
    cookies[name] = 'luma_session=' + (await app.auth.createSession(users[name].id)).token;
  }
  const url = () => `http://127.0.0.1:${app.server.address().port}`;
  async function api(path, { actor = 'admin', method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(url() + path, { method, headers: { ...(actor ? { cookie: cookies[actor] } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  async function generate(input = payload(), files = [], actor = 'member') {
    const form = new FormData(); form.set('metadata', JSON.stringify(input));
    for (const file of files) form.append('files', file);
    const response = await fetch(url() + '/api/generations', { method: 'POST', headers: actor ? { cookie: cookies[actor] } : {}, body: form });
    return { status: response.status, body: await response.json() };
  }
  const configure = () => api('/api/admin/generation-config', { method: 'PUT', body: { baseUrl: 'http://image-service.test/v1/', apiKey: 'Bearer ' + key, models: [{ id: modelId, name: '测试图片模型' }], defaultModel: modelId } });
  return { dir, calls, users, cookies, api, generate, configure, url, get app() { return app; }, mode(value) { mode = value; }, delay(value) { delay = value; }, async restart() { await new Promise(done => app.server.close(done)); app = await createApp(options); await listen(); } };
}

test('配置只允许管理员维护，连接测试不保存密钥，公开配置不暴露服务地址和密钥，重启与清除有效', async t => {
  const env = await setup(t);
  assert.equal((await env.api('/api/admin/generation-config', { actor: null })).status, 401);
  assert.equal((await env.api('/api/admin/generation-config', { actor: 'member' })).status, 403);
  assert.equal((await env.api('/api/admin/generation-config', { actor: 'member', method: 'PUT', body: {} })).status, 403);
  assert.equal((await env.api('/api/admin/generation-models', { actor: 'member', method: 'POST', body: {} })).status, 403);
  const testConnection = await env.api('/api/admin/generation-models', { method: 'POST', body: { baseUrl: 'http://image-service.test/v1', apiKey: key } });
  assert.equal(testConnection.status, 200); assert.equal(testConnection.body.models[0].id, modelId);
  assert.equal((await env.api('/api/admin/generation-config')).body.hasApiKey, false);
  assert.equal((await env.configure()).status, 200);
  assert.equal(env.calls[0].options.headers.Authorization, 'Bearer ' + key);
  for (const actor of ['admin', 'member']) {
    const result = await env.api(actor === 'admin' ? '/api/admin/generation-config' : '/api/generation/config', { actor });
    assert.equal(JSON.stringify(result.body).includes(key), false);
    if (actor === 'member') { assert.equal(result.body.baseUrl, undefined); assert.equal(result.body.available, true); }
  }
  assert.equal((await env.api('/api/admin/generation-config', { method: 'PUT', body: { apiKey: '' } })).body.hasApiKey, true);
  await env.restart(); assert.equal((await env.api('/api/admin/generation-config')).body.hasApiKey, true);
  assert.equal((await env.api('/api/admin/generation-config', { method: 'PUT', body: { clearKey: true } })).body.available, false);
  assert.equal((await env.api('/api/admin/generation-models', { method: 'POST', body: {} })).status, 400);
  assert.equal((await env.api('/api/admin/generation-config', { method: 'PUT', body: { baseUrl: 'file:///secret' } })).status, 400);
  assert.equal((await env.api('/api/admin/generation-config', { method: 'PUT', body: {}, headers: { origin: 'http://foreign.test' } })).status, 403);
  assert.equal((await env.api('/api/admin/generation-models', { method: 'POST', body: {}, headers: { origin: 'http://foreign.test' } })).status, 403);
  assert.equal((await fetch(env.url() + '/data/generation-config.json')).status, 404);
});

test('普通账号可文生图，长模型ID和自定义比例完整保存，图片私有且可Range下载，重启重放不再调用上游', async t => {
  const env = await setup(t); await env.configure();
  const input = payload({ width: 1232, height: 1600 });
  const result = await env.generate(input); assert.equal(result.status, 200);
  const record = result.body.generation;
  assert.equal(record.modelId, modelId); assert.equal(record.model, '测试图片模型'); assert.equal(record.ratio, '77:100');
  assert.equal(record.authorId, env.users.member.id); assert.equal(record.providerResultId, 'provider-fixture-id');
  assert.equal(record.negative, '文字');
  const args = JSON.parse(env.calls[0].options.body);
  assert.equal(args.model, modelId); assert.equal(args.size, '1232x1600'); assert.equal(args.n, 1); assert.match(args.prompt, /不希望出现：\n文字/);
  assert.equal((await fetch(env.url() + record.media[0].url)).status, 404);
  assert.equal((await fetch(env.url() + record.media[0].url, { headers: { cookie: env.cookies.other } })).status, 404);
  const response = await fetch(env.url() + record.media[0].url, { headers: { cookie: env.cookies.member, range: 'bytes=0-19' } });
  assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), picture.subarray(0, 20));
  await env.restart();
  assert.equal((await env.generate(input)).body.generation.id, record.id); assert.equal(env.calls.length, 1);
  assert.equal((await env.generate({ ...input, prompt: 'different' })).status, 409);
  assert.equal((await env.api('/api/user/generations', { actor: 'other' })).body.generations.length, 0);
});

test('参考图使用edits multipart，生成图片可按原有审核流程投稿，自定义比例和modelId跨编辑保留', async t => {
  const env = await setup(t); await env.configure();
  await env.app.auth.completeOnboarding(env.users.member.id, { accountType: 'creator', social: { x: 'https://x.com/generation_test' } });
  await env.app.auth.reviewCreator(env.users.member.id, { decision: 'approve' });
  const reference = new File([picture], 'reference.jpg', { type: 'image/jpeg' });
  const generated = await env.generate(payload(), [reference, reference]); assert.equal(generated.status, 200);
  const call = env.calls[0], record = generated.body.generation;
  assert.ok(call.url.endsWith('/images/edits')); assert.equal(call.options.headers['Content-Type'], undefined);
  assert.equal(call.options.body.getAll('image[]').length, 2); assert.equal(call.options.body.get('model'), modelId);
  const metadata = { id: 'work-' + randomUUID(), revision: 0, requestId: randomUUID(), title: record.title, prompt: record.prompt, model: record.model, category: record.category, ratio: record.ratio, type: 'image', generationId: record.id, media: record.media.map(media => ({ existing: media.id })) };
  const form = new FormData(); form.set('metadata', JSON.stringify(metadata));
  const response = await fetch(env.url() + '/api/works', { method: 'POST', headers: { cookie: env.cookies.member }, body: form });
  assert.equal(response.status, 200); const work = (await response.json()).work;
  assert.equal(work.status, 'pending'); assert.equal(work.modelId, modelId); assert.equal(work.ratio, '2:3');
  assert.notEqual(work.media[0].id, record.media[0].id);
  const published = await env.app.store.review(work.id, { decision: 'approve', expectedRevision: work.revision });
  const edited = await env.app.store.save({ ...metadata, requestId: randomUUID(), revision: published.revision, media: work.media.map(media => ({ existing: media.id })) }, [], env.users.member);
  assert.equal(edited.modelId, modelId); assert.equal(edited.ratio, '2:3');
});

test('并发相同请求合并，不同参数冲突；URL图片下载不携带认证头，缺失上游编号保持null', async t => {
  const env = await setup(t); await env.configure(); env.mode('url');
  let release; env.delay(new Promise(resolve => { release = resolve; }));
  const input = payload(), first = env.generate(input);
  while (!env.calls.length) await new Promise(resolve => setTimeout(resolve, 5));
  const second = env.generate(input);
  const conflict = await env.generate({ ...input, count: 2 }).finally(release);
  assert.equal(conflict.status, 409);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(a.body.generation.id, b.body.generation.id);
  assert.equal(a.body.generation.providerResultId, null); assert.equal(env.calls.length, 2);
});

test('鉴权、模型、尺寸和参考图边界在调用上游前拒绝', async t => {
  const env = await setup(t); await env.configure();
  assert.equal((await env.generate(payload(), [], null)).status, 401);
  for (const overrides of [{ modelId: 'disabled' }, { count: 5 }, { width: 0 }, { height: 1.5 }]) assert.equal((await env.generate(payload(overrides))).status, 400);
  assert.equal((await env.generate(payload(), [new File(['not-image'], 'fake.jpg', { type: 'image/jpeg' })])).status, 415);
  assert.equal((await env.generate(payload(), Array.from({ length: 5 }, () => new File([picture], 'ref.jpg', { type: 'image/jpeg' })))).status, 400);
  assert.equal(env.calls.length, 0);
  const response = await fetch(env.url() + '/api/generations', { method: 'POST', headers: { cookie: env.cookies.member, origin: 'http://foreign.test' } });
  assert.equal(response.status, 403);
});

test('上游错误、限流、超时和无效结果均无成功记录且不自动重试，错误不泄露Key', async t => {
  const env = await setup(t, { timeoutMs: 30 }); await env.configure();
  for (const [mode, status] of [['auth', 502], ['size', 502], ['rate', 429], ['network', 502], ['timeout', 504], ['json', 502], ['empty', 502], ['invalid', 502]]) {
    env.mode(mode); const input = payload(), before = env.calls.length;
    const result = await env.generate(input); assert.equal(result.status, status, mode);
    assert.equal(JSON.stringify(result.body).includes(key), false);
    assert.equal((await env.generate(input)).status, status); assert.equal(env.calls.length, before + 1);
  }
  assert.equal((await env.api('/api/user/generations', { actor: 'member' })).body.generations.length, 0);
  assert.deepEqual(await readdir(join(env.dir, 'generated-media')), []);
});

test('落盘失败不能伪造成功，也不会重放相同请求再次调用上游', async t => {
  const env = await setup(t); await env.configure();
  env.app.generations.record = async () => { throw new HttpError(507, '生成结果保存失败。'); };
  const input = payload();
  assert.equal((await env.generate(input)).status, 507); assert.equal((await env.generate(input)).status, 507);
  assert.equal(env.calls.length, 1); assert.deepEqual(await readdir(join(env.dir, 'generations')), []);
});
