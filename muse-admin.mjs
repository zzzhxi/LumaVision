import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readBounded } from './generation-service.mjs';
import { HttpError } from './storage.mjs';

export const museAdminPath = '/api/admin/muse';
const payloadLimit = 256 * 1024;
const mediaPath = /^\/v1\/media\/[\w.-]+\.(?:png|jpe?g|gif|webp|mp4|mov|webm|avif|hei[cf])(?:\/thumbnail)?$/i;
const account = /^\/admin\/accounts\/[\w-]+$/;
const accountAction = /^\/admin\/accounts\/[\w-]+\/(?:test|relogin|cookies|quota|keepalive|proxy\/test)$/;
const task = /^\/admin\/tasks\/[\w-]+$/;
const methods = {
  GET: [
    /^\/(?:admin|healthz|readyz)$/, mediaPath,
    /^\/admin\/(?:status|accounts|tasks|media|generation-queue|keepalive\/status|update\/check|repo\/status|extension(?:\/files)?|cookie-helper)$/,
    /^\/v1\/(?:models|images\/tasks\/[\w-]+|videos\/[\w-]+)$/
  ],
  HEAD: [mediaPath],
  POST: [
    /^\/admin\/(?:accounts(?:\/keepalive)?|tasks\/clear|media\/delete)$/, accountAction,
    /^\/v1\/(?:images\/tasks|videos)$/
  ],
  PUT: [/^\/admin\/generation-queue$/],
  PATCH: [account],
  DELETE: [account, task, /^\/admin\/media\/[\w.-]+$/]
};
const privateFields = new Set(['api_key', 'apiKey', 'cookie_header', 'cookies', 'github_token', 'password', 'previous', 'input']);
const pagePolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const bridgeStyle = `<style>
#keyBox input,#keyBox button,#extensionUpgradeNotice,
button[onclick="rotateKey()"],button[onclick="upgradeNow()"],
div:has(> .copyline > #inKey),section#tab-cookie > .card:has(#exKey),
[data-i18n="cli-script-hint"],#tab-cookie .row:has(#cmdBox),#tab-cookie .hint:has(+ .row #cmdBox),
#tab-cookie .row:has(#cmdBox) + .hint {display:none!important}
.luma-muse-back{display:block;width:max-content;max-width:100%;padding:0 clamp(12px,1.2vw,24px) 10px}
</style>`;

function adaptPage(html) {
  const edits = [
    [/<\/head>/i, bridgeStyle + '</head>'],
    [/<\/header>/i, '<a class="luma-muse-back" href="../../../#admin/generation">返回 LumaVision 生成服务</a></header>'],
    [/let KEY = localStorage\.getItem\(KEY_STORE\)[^\r\n]*;/, "let KEY = '';\nconst LUMA_MUSE_PATH = location.pathname.replace(/\\/$/, '');"],
    [/if \(KEY\) opts\.headers\['Authorization'\] = 'Bearer ' \+ KEY;/, 'opts.credentials = \'same-origin\';'],
    ['fetch(path, opts)', 'fetch(LUMA_MUSE_PATH + path, opts)']
  ];
  for (const [pattern, value] of edits) {
    const next = html.replace(pattern, () => value);
    if (next === html) throw new HttpError(502, '当前 muse2api 管理页版本无法接入，请检查已安装版本。');
    html = next;
  }
  return html
    .replace(/href=(\\?)"\/admin\//g, 'href=$1"./admin/')
    .replace(/fetch\('\/healthz\?/g, "fetch(LUMA_MUSE_PATH + '/healthz?")
    .replace(/<div data-i18n="auth-banner">[\s\S]*?<\/div>/, '<div>请返回 LumaVision 检查管理员会话或 Muse 服务配置。</div>')
    .replace("throw new Error('API Key 未填写或填写错误');", "throw new Error('管理员会话或 Muse 服务鉴权已失效。');")
    .replaceAll('🔑 请先在右上角填入 API Key 并点「保存」', '请返回 LumaVision 检查管理员会话或 Muse 服务配置。')
    .replace('官方仓库已有新功能或性能优化提交，点击右侧按钮即可一键在线升级（自动保留本地 .env 密钥与账号池数据）。', '请通过服务器运维流程更新引擎。')
    .replace(/\$\('updBannerMsg'\)\.textContent = s\.managed_deployment[^;]*;/, "$('updBannerMsg').textContent = LANG === 'en' ? 'Update the engine from the server.' : '请通过服务器运维流程更新引擎。';")
    .replace('此实例通过镜像部署，更新需从上述分支构建并切换容器。', '请通过服务器运维流程更新引擎。')
    .replace('<h3>接入信息 <span class="tag">下游项目填这两个值</span></h3>', '<h3>LumaVision 接入</h3>')
    .replace('把下面两项填进你的项目就能调用。BASE URL 就是接口地址前缀。', '本页使用 LumaVision 管理员会话。引擎 Key 和程序更新由服务器运维管理。')
    .replace('方式三：粘贴导入 / 本机脚本', '粘贴导入')
    .replace("$('dBase').textContent = location.origin + '/v1';", "$('dBase').textContent = $('inBase').value = location.origin + LUMA_MUSE_PATH + '/v1';")
    .replace('function refreshAll(){ loadStatus(); loadPool(); loadApikey(); loadRepoStatus(false); }', 'function refreshAll(){ loadStatus(); loadPool(); loadRepoStatus(false); }');
}

function safeResponse(value, key, field) {
  if (typeof value === 'string') {
    const text = value.replaceAll(key, '[已隐藏]');
    if (field === 'url' || field === 'thumbnail_url') {
      const url = URL.canParse(text, 'http://127.0.0.1') ? new URL(text, 'http://127.0.0.1') : null;
      if (url && mediaPath.test(url.pathname)) return '.' + url.pathname + url.search;
      // Media URLs in engine task and gallery responses are links to engine files.
      if (field === 'thumbnail_url' || /^(?:[a-z]+:|\/)/i.test(text) && !/^https:\/\/github\.com\//i.test(text)) return '';
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => safeResponse(item, key, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !privateFields.has(name))
    .map(([name, item]) => [name, name === 'base_url' ? '' : safeResponse(item, key, name)]));
  return value;
}

export async function serveMuseAdmin(req, res, { path, connection, readBody, verifyWrite, sendJson, fetchImpl = fetch }) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (path === museAdminPath && req.method === 'GET') {
    res.writeHead(308, { Location: 'muse/' });
    res.end();
    return;
  }
  const suffix = path.slice(museAdminPath.length);
  const targetPath = suffix === '/' ? '/admin' : suffix;
  if (suffix === '/admin' || !Object.hasOwn(methods, req.method) || !methods[req.method].some(pattern => pattern.test(targetPath))) {
    throw new HttpError(404, 'Muse 管理接口不存在。');
  }
  if (!connection) throw new HttpError(503, '请先在 LumaVision 的 Muse 生图配置或视频配置中填写本机 muse2api 的地址和引擎 Key。');
  const { baseUrl, apiKey } = connection;
  const headers = { Authorization: 'Bearer ' + apiKey };
  const media = mediaPath.test(targetPath);
  if (media && req.headers.range) headers.Range = req.headers.range;
  let requestBody;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    requestBody = await readBody(req, payloadLimit);
    await verifyWrite();
    if (requestBody.length) {
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Muse 管理请求须使用 JSON。');
      headers['Content-Type'] = 'application/json';
    } else requestBody = undefined;
  }
  const url = new URL(targetPath, baseUrl);
  if (targetPath !== '/admin') url.search = new URL(req.url, 'http://127.0.0.1').search;
  // The engine exposes media with GET only, so use its headers for HEAD and cancel its body.
  const head = req.method === 'HEAD';
  let upstream;
  try {
    upstream = await fetchImpl(url, { method: head ? 'GET' : req.method, headers, body: requestBody, signal: AbortSignal.timeout(120000), redirect: 'error' });
  } catch {
    throw new HttpError(502, '无法连接本机 muse2api，请检查服务是否已启动。');
  }
  const contentType = upstream.headers.get('content-type') || '';
  if (targetPath === '/admin') {
    if (!upstream.ok || !/^text\/html(?:;|$)/i.test(contentType)) {
      await upstream.body?.cancel();
      throw new HttpError(502, '本机服务未返回 muse2api 管理页，请检查服务地址。');
    }
    const html = adaptPage((await readBounded(upstream, 2 * 1024 ** 2, 'Muse 管理页')).toString('utf8'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pagePolicy });
    res.end(html);
    return;
  }
  const download = targetPath === '/admin/extension' || targetPath === '/admin/cookie-helper';
  if (media && (upstream.ok || upstream.status === 416) || download && upstream.ok) {
    const allowedType = media ? /^(?:image\/(?:png|jpeg|gif|webp|avif|hei[cf])|video\/(?:mp4|quicktime|webm))(?:;|$)/i : /^(?:application\/(?:zip|octet-stream)|text\/x-python)(?:;|$)/i;
    if (upstream.ok && !allowedType.test(contentType)) {
      await upstream.body?.cancel();
      throw new HttpError(502, 'Muse 返回的文件类型不受支持。');
    }
    if (upstream.ok) res.setHeader('Content-Type', contentType);
    for (const header of ['accept-ranges', 'content-range']) {
      if (media && upstream.headers.has(header)) res.setHeader(header, upstream.headers.get(header));
    }
    if (upstream.headers.has('content-length') && !upstream.headers.has('content-encoding')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    if (download) res.setHeader('Content-Disposition', targetPath.endsWith('extension')
      ? 'attachment; filename="muse2api-extension.zip"' : 'attachment; filename="get_muse_cookie.py"');
    res.writeHead(upstream.status);
    if (head) {
      await upstream.body?.cancel();
      res.end();
    } else if (!upstream.body) res.end();
    else await pipeline(Readable.fromWeb(upstream.body), res);
    return;
  }
  const bytes = await readBounded(upstream, 4 * 1024 ** 2, 'Muse 管理接口');
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpError(502, 'Muse 管理接口返回了无法读取的结果。'); }
  sendJson(res, upstream.status, safeResponse(data, apiKey));
}
