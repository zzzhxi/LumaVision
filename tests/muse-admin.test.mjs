import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApp } from '../server.mjs';

const mount = '/api/admin/muse/';
const engine = 'http://127.0.0.1:18610';
const engineKey = 'private-muse-admin-test-key';
const template = `<!doctype html><html><head><title>muse2api</title></head><body>
<header><span id="keyBox"><input id="key"></span></header>
<main><div id="authBanner"><div data-i18n="auth-banner">输入 API Key</div></div>
<a href="/admin/extension" download>Download</a><section id="tab-pool">账号池</section></main>
<script>
let KEY = localStorage.getItem(KEY_STORE) || new URLSearchParams(location.search).get('key') || '';
async function api(path, opts){
  if (KEY) opts.headers['Authorization'] = 'Bearer ' + KEY;
  const r = await fetch(path, opts);
}
</script></body></html>`;

async function setup(t, { configured = true, upstream } = {}) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'luma-muse-admin-'));
  if (configured) await writeFile(join(storageRoot, 'generation-config.json'), JSON.stringify({ muse: { apiKey: engineKey } }));
  const calls = [];
  const app = await createApp({ storageRoot, museAdminFetch: async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === engine + '/admin') return new Response(template, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return upstream?.(String(url), options) ?? Response.json({ ok: true });
  } });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await rm(storageRoot, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const cookies = {};
  for (const name of ['admin', 'member']) {
    const user = await app.auth.upsertByEmail(name + '@example.test', { nickname: name });
    cookies[name] = 'luma_session=' + (await app.auth.createSession(user.id)).token;
  }
  function request(path, { actor = 'admin', method = 'GET', headers = {}, body } = {}) {
    return fetch(origin + path, { method, headers: { ...(actor && { Cookie: cookies[actor] }), ...headers }, body, redirect: 'manual' });
  }
  return { calls, origin, request };
}

test('原版 Muse 管理页和其接口使用 LumaVision 管理员会话，且在当前站点子路径下工作', async t => {
  const env = await setup(t);
  for (const path of [mount, mount + 'admin/accounts', mount + 'v1/media/clip.mp4', mount + 'admin/extension']) {
    assert.equal((await env.request(path, { actor: null })).status, 401);
    assert.equal((await env.request(path, { actor: 'member' })).status, 403);
  }
  assert.equal(env.calls.length, 0);
  const redirect = await env.request(mount.slice(0, -1));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), 'muse/');
  const result = await env.request(mount + '?key=browser-input');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await result.text();
  assert.match(html, /账号池/);
  assert.match(html, /location\.pathname/);
  assert.match(html, /href="\.\/admin\/extension"/);
  assert.match(html, /href="\.\.\/\.\.\/\.\.\/#admin\/generation"/);
  assert.doesNotMatch(html, /browser-input|private-muse-admin-test-key|localStorage\.getItem\(KEY_STORE\)|opts\.headers\['Authorization'\]/);
  assert.equal(env.calls[0].url, engine + '/admin');
});

test('Muse 管理写操作拒绝跨站请求，限制上游接口并由服务端注入密钥', async t => {
  const env = await setup(t);
  const accounts = mount + 'admin/accounts';
  const body = JSON.stringify({ label: 'test', cookie_header: 'hatch_sess=' + 'fixture-login-session' });
  assert.equal((await env.request(accounts, { method: 'POST', headers: { Origin: 'https://foreign.test', 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await env.request(mount + 'admin/apikey', {})).status, 404);
  assert.equal((await env.request(mount + 'admin/apikey/rotate', { method: 'POST' })).status, 404);
  assert.equal((await env.request(mount + 'admin/update/upgrade', { method: 'POST' })).status, 404);
  assert.equal((await env.request(mount + 'admin%2F..%2Fhealthz')).status, 404);
  assert.equal(env.calls.length, 0);
  const result = await env.request(accounts, { method: 'POST', headers: { Origin: env.origin, 'Content-Type': 'application/json', Authorization: 'Bearer client-value' }, body });
  assert.equal(result.status, 200);
  const [{ url, options }] = env.calls;
  assert.equal(url, engine + '/admin/accounts');
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer ' + engineKey);
  assert.equal(new Headers(options.headers).get('cookie'), null);
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(String(options.body)), JSON.parse(body));
});

test('Muse 管理响应保留媒体 Range，返回同站路径并滤除凭据', async t => {
  const env = await setup(t, { upstream: (url, options) => {
    if (url.includes('/v1/media/')) {
      assert.equal(new Headers(options.headers).get('range'), 'bytes=0-2');
      if (options.method !== 'GET') return Response.json({ detail: 'Method Not Allowed' }, { status: 405 });
      return new Response('abc', { status: 206, headers: { 'Content-Type': url.endsWith('.mov') ? 'video/quicktime' : 'video/mp4',
        'Content-Range': 'bytes 0-2/6', 'Content-Length': '3', 'Set-Cookie': ['fixture_cookie', 'sample; Path=/'].join('=') } });
    }
    return Response.json({ api_key: engineKey, accounts: [{ label: '测试', cookies: { hatch_sess: 'hidden-cookie' } }],
      media: [{ url: engine + '/v1/media/clip.mp4', thumbnail_url: '/v1/media/clip.mp4/thumbnail?v=1' }, { url: '/v1/media/legacy.mov' }], detail: engineKey });
  } });
  const list = await (await env.request(mount + 'admin/media')).json();
  assert.deepEqual(list.accounts, [{ label: '测试' }]);
  assert.doesNotMatch(JSON.stringify(list), /private-muse-admin-test-key|hidden-cookie|api_key/);
  assert.deepEqual(list.media, [{ url: './v1/media/clip.mp4', thumbnail_url: './v1/media/clip.mp4/thumbnail?v=1' }, { url: './v1/media/legacy.mov' }]);
  const range = await env.request(mount + 'v1/media/clip.mp4', { headers: { Range: 'bytes=0-2' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-2/6');
  assert.equal(range.headers.get('set-cookie'), null);
  assert.equal(await range.text(), 'abc');
  const head = await env.request(mount + 'v1/media/clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=0-2' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), 'bytes 0-2/6');
  assert.equal(head.headers.get('content-length'), '3');
  assert.equal(await head.text(), '');
  const mov = await env.request(mount + 'v1/media/legacy.mov', { headers: { Range: 'bytes=0-2' } });
  assert.equal(mov.status, 206);
  assert.equal(mov.headers.get('content-type'), 'video/quicktime');
  assert.equal(await mov.text(), 'abc');
});

test('未配置 muse2api 时给出可操作的提示且无需连接引擎', async t => {
  const env = await setup(t, { configured: false });
  const res = await env.request(mount);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Muse 生图配置|视频配置/);
  assert.equal(env.calls.length, 0);
});
