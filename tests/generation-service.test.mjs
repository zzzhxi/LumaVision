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
const museKey = 'offline-muse-key-sentinel';
const payload = overrides => ({ requestId: randomUUID(), title: '测试生成', prompt: 'A quiet sea.', negative: '文字', modelId, category: '自然风光', width: 1024, height: 1536, count: 1, ...overrides });
async function setup(t, { timeoutMs = 1000 } = {}) {
  const dir = await mkdtemp(join(parent, 'generation-test-'));
  const calls = [];
  let mode = 'base64', delay = null, policyBody = '', policyType = 'application/json', museComplete = true;
  let failMusePoll = false, failMuseDownload = false;
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'http://127.0.0.1:18610/v1/models') return Response.json({ data: [{ id: 'muse-image' }] });
    if (String(url).endsWith('/images/tasks')) return Response.json({ id: 'muse-fixture', status: 'queued' }, { status: 202 });
    if (String(url).endsWith('/images/tasks/muse-fixture')) {
      if (failMusePoll) { failMusePoll = false; throw new Error('engine temporarily offline'); }
      return Response.json(museComplete ? { status: 'completed', data: [{ url: '/v1/media/muse-fixture.jpg' }] } : { status: 'processing' });
    }
    if (String(url).endsWith('/v1/media/muse-fixture.jpg')) {
      if (failMuseDownload) { failMuseDownload = false; return Response.json({ error: 'temporary download failure' }, { status: 503 }); }
      return new Response(picture);
    }
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
    if (mode === 'policy') return new Response(policyBody, { status: 400, headers: { 'Content-Type': policyType } });
    if (mode === 'json') return new Response('not-json');
    if (mode === 'empty') return Response.json({ data: [] });
    if (mode === 'invalid') return Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
    if (mode === 'url') return Response.json({ data: [{ url: 'http://image-service.test/output.jpg' }] });
    return Response.json({ data: [{ b64_json: picture.toString('base64') }] }, { headers: { 'x-request-id': 'provider-fixture-id' } });
  };
  const options = { storageRoot: dir, generationFetch: fetchImpl, generationTimeoutMs: timeoutMs, museImagePollMs: 10, sendAuthCode: async () => ({ delivery: 'email' }) };
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
  const configure = (overrides = {}) => api('/api/admin/generation-config', { method: 'PUT', body: { baseUrl: 'http://image-service.test/v1/', apiKey: 'Bearer ' + key, models: [{ id: modelId, name: '测试图片模型' }], defaultModel: modelId, ...overrides } });
  return { dir, calls, users, cookies, api, generate, configure, url, get app() { return app; }, mode(value) { mode = value; }, policy(body, type) { policyBody = body; policyType = type; }, delay(value) { delay = value; }, museComplete(value) { museComplete = value; }, failNextMuseReads() { failMusePoll = failMuseDownload = true; }, async restart(onStopped) { await new Promise(done => app.server.close(done)); onStopped?.(); app = await createApp(options); await listen(); } };
}

test('Muse Image 由管理员配置，启用后向登录用户提供单张生成', async t => {
  const env = await setup(t);
  await env.configure();
  const config = '/api/admin/generation-config';
  const muse = { enabled: true, apiKey: museKey };
  assert.equal((await env.api(config)).body.muse.enabled, false);
  assert.equal((await env.generate(payload({ modelId: 'muse-image' }))).status, 503);
  assert.equal((await env.api(config, { method: 'PUT', body: { muse: { ...muse, baseUrl: 'https://example.test/v1' } } })).status, 400);
  assert.equal((await env.api(config, { method: 'PUT', body: { muse }, actor: 'member' })).status, 403);
  assert.equal((await env.api('/api/admin/generation-models', { method: 'POST', body: { muse } })).status, 200);
  assert.equal((await env.api(config)).body.muse.hasApiKey, false);
  const saved = await env.api(config, { method: 'PUT', body: { muse } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.baseUrl, 'http://image-service.test/v1');
  assert.equal(JSON.stringify(saved.body).includes(muse.apiKey), false);
  const catalogue = '/api/generation/config';
  const { body: options } = await env.api(catalogue, { actor: 'member' });
  assert.equal(options.models.find(item => item.id === 'muse-image')?.category, 'Muse Image');
  assert.equal(JSON.stringify(options).includes(museKey), false);
  assert.equal((await env.generate(payload({ modelId: 'muse-image' }), [], null)).status, 401);
  assert.equal((await env.generate(payload({ modelId: 'muse-image', count: 2 }))).status, 400);
  assert.equal((await env.generate()).status, 200);
});

test('Muse Image 异步接收参考图，重启后继续单次任务并保存私有成图', async t => {
  const env = await setup(t);
  env.museComplete(false);
  await env.api('/api/admin/generation-config', { method: 'PUT', body: { muse: { enabled: true, apiKey: museKey } } });
  const input = payload({ modelId: 'muse-image', modelCategory: 'GPT Image', width: 1536, height: 864 });
  const reference = new File([picture], 'reference.jpg', { type: 'image/jpeg' });
  const result = await env.generate(input, [reference]);
  assert.equal(result.status, 202);
  const path = `/api/generations/muse/${input.requestId}`;
  assert.equal((await env.api(path, { actor: null })).status, 401);
  assert.equal((await env.api(path)).status, 404);
  assert.equal((await env.generate(input, [reference])).status, 202);
  assert.equal((await env.generate({ ...input, prompt: 'changed' }, [reference])).status, 409);
  await env.api('/api/admin/generation-config', { method: 'PUT', body: { muse: { enabled: false } } });
  const now = Date.now;
  await env.restart(() => {
    t.mock.method(Date, 'now', () => now() + 16 * 60_000);
    env.failNextMuseReads();
  });
  const deadline = now() + 3000;
  let pending;
  do {
    pending = await env.api(path, { actor: 'member' });
    if (pending.status !== 202 || pending.body.job.status === 'processing') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (now() < deadline);
  assert.equal(pending.body.job?.status, 'processing', pending.body.job?.error);
  env.museComplete(true);
  let completed;
  do {
    completed = await env.api(path, { actor: 'member' });
    if (completed.status !== 202) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (now() < deadline);
  assert.equal(completed.status, 200);
  const record = completed.body.generation;
  assert.ok(record, completed.body.job?.error);
  assert.equal(record.provider, 'Muse');
  assert.equal(record.model, 'Muse Image');
  assert.equal(record.providerResultId, 'muse-fixture');
  assert.equal(record.authorId, env.users.member.id);
  const submissions = env.calls.filter(call => call.url.endsWith('/images/tasks'));
  assert.equal(submissions.length, 1);
  assert.equal(env.calls.filter(call => call.url.endsWith('/v1/media/muse-fixture.jpg')).length, 2);
  assert.equal(submissions[0].options.headers.Authorization, 'Bearer ' + museKey);
  assert.ok(submissions[0].options.headers['Idempotency-Key']);
  const args = JSON.parse(submissions[0].options.body);
  assert.equal(args.aspect_ratio, '16:9');
  assert.equal(args.images[0], `data:image/jpeg;base64,${picture.toString('base64')}`);
  assert.equal((await fetch(env.url() + record.media[0].url, { headers: { cookie: env.cookies.admin } })).status, 404);
  assert.equal((await fetch(env.url() + record.media[0].url, { headers: { cookie: env.cookies.member, range: 'bytes=0-19' } })).status, 206);
  assert.equal((await env.generate(payload({ modelId: 'muse-image' }))).status, 503);
});

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
  assert.equal(record.modelId, modelId); assert.equal(record.model, 'GPT Image'); assert.equal(record.modelName, '测试图片模型'); assert.equal(record.ratio, '77:100');
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
  assert.equal(work.status, 'pending'); assert.equal(work.modelId, modelId); assert.equal(work.model, 'GPT Image'); assert.equal(work.ratio, '2:3');
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

test('模型别称与模型分类可配置，生成记录按分类归档，未开放的分类不生效', async t => {
  const env = await setup(t);
  assert.equal((await env.configure({ models: [{ id: modelId, name: 'GPT Image 2.6', category: 'FLUX' }] })).status, 200);
  const saved = await env.api('/api/admin/generation-config');
  assert.equal(saved.body.models[0].name, 'GPT Image 2.6'); assert.equal(saved.body.models[0].category, 'FLUX');
  const published = await env.api('/api/generation/config', { actor: 'member' });
  assert.equal(published.body.models[0].name, 'GPT Image 2.6'); assert.equal(published.body.models[0].category, 'FLUX');
  assert.equal((await env.api('/api/admin/generation-config', { method: 'PUT', body: { models: [{ id: modelId, category: 7 }] } })).status, 400);
  const grouped = await env.generate(payload());
  assert.equal(grouped.status, 200); assert.equal(grouped.body.generation.model, 'FLUX'); assert.equal(grouped.body.generation.modelName, 'GPT Image 2.6');
  const unknown = await env.generate(payload({ modelCategory: 'Nano Banana' }));
  assert.equal(unknown.body.generation.model, 'FLUX');
  const defaultGroup = await env.generate(payload({ modelCategory: 'GPT Image' }));
  assert.equal(defaultGroup.body.generation.model, 'GPT Image');
  assert.equal((await env.generate(payload({ modelCategory: 7 }))).status, 400);
});

test('上游400的失败原因原样回传，正文形状不影响提示，错误里不含密钥', async t => {
  const env = await setup(t); await env.configure();
  const policy = '非常抱歉，生成的图片可能违反了我们的内容政策。如果你认为此判断有误，请重试或修改提示语。';
  const bodies = [
    [JSON.stringify({ error: { message: policy, type: 'new_api_error' } }), 'application/json'],
    [JSON.stringify({ message: policy }), 'application/json'],
    [JSON.stringify({ detail: policy }), 'application/json'],
    [JSON.stringify({ error: { content: [{ type: 'text', text: policy }] } }), 'application/json'],
    [policy, 'text/plain']
  ];
  for (const [body, type] of bodies) {
    env.mode('policy'); env.policy(body, type);
    const result = await env.generate(payload());
    assert.equal(result.status, 400);
    assert.ok(result.body.error.includes(policy), '应回传上游原因，实际：' + result.body.error);
    assert.equal(JSON.stringify(result.body).includes(key), false);
  }
  env.mode('policy'); env.policy('<!DOCTYPE html><html><body>blocked</body></html>', 'text/html');
  const html = await env.generate(payload());
  assert.equal(html.status, 400);
  assert.equal(html.body.error, '生图服务拒绝请求（HTTP 400）。');
  env.mode('policy'); env.policy('Bearer ' + key + ' 不可用', 'text/plain');
  const leaked = await env.generate(payload());
  assert.equal(leaked.status, 400); assert.equal(JSON.stringify(leaked.body).includes(key), false);
});

test('上游错误、限流、超时和无效结果均无成功记录且不自动重试，错误不泄露Key', async t => {
  const env = await setup(t, { timeoutMs: 30 }); await env.configure();
  for (const [mode, status] of [['auth', 502], ['size', 400], ['rate', 429], ['network', 502], ['timeout', 504], ['json', 502], ['empty', 502], ['invalid', 502]]) {
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
