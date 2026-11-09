import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, identify, limits } from './storage.mjs';

const defaultBaseUrl = 'http://127.0.0.1:38650/v1';
const assert = (ok, message, status = 400) => { if (!ok) throw new HttpError(status, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function requiredText(value, max, name) {
  assert(typeof value === 'string' && value.trim() && value.length <= max, name + '不正确。');
  return value.trim();
}
function serviceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new HttpError(400, 'Base URL 不正确。'); }
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Base URL 只支持不含账号、查询参数的 HTTP/HTTPS 地址。');
  return url.href.replace(/\/+$/, '');
}
function normalizeConfig(input, previous) {
  assert(input && typeof input === 'object', '生图配置不正确。');
  const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
  assert(input.apiKey === undefined || typeof input.apiKey === 'string', 'API Key 不正确。');
  const supplied = (input.apiKey || '').trim().replace(/^Bearer\s+/i, '').trim();
  const apiKey = input.clearKey === true ? '' : supplied || previous.apiKey;
  assert(apiKey.length <= 4096 && !/[\r\n]/.test(apiKey), 'API Key 不正确。');
  const models = input.models ?? previous.models;
  assert(Array.isArray(models) && models.length <= 50, '最多启用 50 个模型。');
  const normalized = models.map(model => {
    const id = requiredText(model?.id, 200, '模型 ID');
    return { id, name: requiredText(model.name || id.slice(0, 40), 40, '模型名称') };
  });
  assert(new Set(normalized.map(model => model.id)).size === normalized.length, '模型 ID 不能重复。');
  const defaultModel = input.defaultModel ?? previous.defaultModel;
  assert(typeof defaultModel === 'string' && (!normalized.length ? !defaultModel : normalized.some(model => model.id === defaultModel)), '请选择已启用的默认模型。');
  return { baseUrl, apiKey, models: normalized, defaultModel };
}
function redact(value, key) {
  return String(value || '').split(key || '\0').join('[已隐藏]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').slice(0, 300);
}
async function readBounded(response, max) {
  assert(Number(response.headers.get('content-length') || 0) <= max, '生图服务返回内容过大。', 502);
  const reader = response.body?.getReader();
  assert(reader, '生图服务没有返回内容。', 502);
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      assert(size <= max, '生图服务返回内容过大。', 502);
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
function ratioFor(width, height) {
  let a = width, b = height;
  while (b) [a, b] = [b, a % b];
  return `${width / a}:${height / a}`;
}

export function createGenerationService(storageRoot, generations, { fetchImpl = fetch, timeoutMs = 240000 } = {}) {
  const path = join(storageRoot, 'generation-config.json');
  let config = { baseUrl: defaultBaseUrl, apiKey: '', models: [], defaultModel: '' };
  const ready = (async () => {
    try { config = normalizeConfig(JSON.parse(await readFile(path, 'utf8')), config); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取生图配置，请检查 generation-config.json。'); }
  })();
  let configQueue = Promise.resolve();
  let active = 0;
  const requests = new Map();
  function publicConfig(admin = false) {
    return { available: !!(config.apiKey && config.models.length), models: config.models, defaultModel: config.defaultModel,
      ...(admin ? { baseUrl: config.baseUrl, hasApiKey: !!config.apiKey } : {}) };
  }
  async function upstream(url, options, key, max, signal) {
    let response, bytes;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal });
      bytes = await readBounded(response, response.ok ? max : 65536);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(signal.aborted ? 504 : 502, signal.aborted ? '生图服务请求超时，请先检查生成记录，避免重复生成。' : '无法连接生图服务，请检查服务地址和运行状态。');
    }
    if (!response.ok) {
      let data;
      try { data = JSON.parse(bytes.toString()); } catch { /* Non-JSON errors use a safe status message. */ }
      const detail = redact(data?.error?.message || (typeof data?.error === 'string' ? data.error : ''), key);
      const message = response.status === 401 || response.status === 403 ? '生图服务密钥无效或无权限，请联系管理员。' : response.status === 429 ? '生图服务请求受限，请稍后再试。' : '生图服务拒绝请求' + (detail ? '：' + detail : `（HTTP ${response.status}）。`);
      throw new HttpError(response.status === 429 ? 429 : 502, message);
    }
    return { response, bytes };
  }
  function parseJson(bytes) {
    try { return JSON.parse(bytes.toString()); } catch { throw new HttpError(502, '生图服务返回的 JSON 无法解析。'); }
  }
  return {
    ready,
    async settings(admin = false) { await ready; return publicConfig(admin); },
    async save(input) {
      await ready;
      const save = async () => {
        const next = normalizeConfig(input, config), temp = path + '.' + randomUUID() + '.tmp';
        try { await writeFile(temp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, path); config = next; }
        finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return publicConfig(true);
      };
      const result = configQueue.then(save); configQueue = result.catch(() => {}); return result;
    },
    async models(input) {
      await ready;
      const candidate = normalizeConfig({ ...input, models: config.models, defaultModel: config.defaultModel }, config);
      assert(candidate.apiKey, '请先填写 API Key。');
      const { bytes } = await upstream(candidate.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + candidate.apiKey } }, candidate.apiKey, 2 * 1024 ** 2, AbortSignal.timeout(Math.min(timeoutMs, 15000)));
      const data = parseJson(bytes);
      assert(Array.isArray(data?.data), '模型列表格式不正确。', 502);
      return { models: data.data.filter(model => typeof model?.id === 'string' && model.id.trim() && model.id.length <= 200).map(model => ({ id: model.id, name: model.id.slice(0, 40) })) };
    },
    async generate(input, uploads, author) {
      await ready;
      assert(input && typeof input === 'object', '生成参数不正确。');
      const requestId = requiredText(input.requestId, 36, '请求编号');
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId), '请求编号不正确。');
      const modelId = requiredText(input.modelId, 200, '模型 ID');
      const title = input.title ? requiredText(input.title, 70, '创作名称') : '未命名创作';
      const prompt = requiredText(input.prompt, 8000, '提示词');
      assert(input.negative === undefined || typeof input.negative === 'string' && input.negative.length <= 2000, '负面提示词不正确。');
      const negative = (input.negative || '').trim();
      const category = requiredText(input.category, 30, '分类');
      assert(Number.isInteger(input.count) && input.count >= 1 && input.count <= 4, '生成数量必须为 1–4 张。');
      assert(Number.isInteger(input.width) && input.width > 0 && input.width <= 9999 && Number.isInteger(input.height) && input.height > 0 && input.height <= 9999, '图片宽高必须为 1–9999 的正整数。');
      assert(Array.isArray(uploads) && uploads.length <= 4, '最多添加 4 张参考图。');
      const references = [];
      for (const file of uploads) {
        assert(file.size > 0 && file.size <= limits.image, '参考图单张不能超过 20 MB。', 413);
        const bytes = file.tempPath ? await readFile(file.tempPath) : Buffer.from(await file.arrayBuffer());
        const format = identify(bytes);
        assert(format?.type === 'image' && (!file.type || file.type === format.mime || file.type === 'application/octet-stream'), '参考图必须是有效的 JPEG、PNG、WebP 或 GIF。', 415);
        references.push({ bytes, format, hash: hash(bytes) });
      }
      const params = { title, prompt, negative, category, modelId, width: input.width, height: input.height, count: input.count };
      const requestHash = hash(JSON.stringify({ ...params, references: references.map(file => file.hash) }));
      const key = hash(author.id + ':' + requestId), hex = key.slice(0, 32);
      const id = 'generation-' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      const previous = requests.get(key);
      if (previous) { assert(previous.hash === requestHash, '相同请求编号的参数不一致。', 409); return previous.promise; }
      const generateImages = async (snapshot, model) => {
        const signal = AbortSignal.timeout(timeoutMs);
        const text = prompt + (negative ? '\n\n不希望出现：\n' + negative : '');
        const args = { model: modelId, prompt: text, n: input.count, size: `${input.width}x${input.height}` };
        const headers = { Authorization: 'Bearer ' + snapshot.apiKey };
        let payload, endpoint;
        if (references.length) {
          payload = new FormData(); for (const [key, value] of Object.entries(args)) payload.set(key, String(value));
          for (const [index, ref] of references.entries()) payload.append('image[]', new File([ref.bytes], `reference-${index + 1}.${ref.format.ext}`, { type: ref.format.mime }));
          endpoint = '/images/edits';
        } else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(args); endpoint = '/images/generations'; }
        const { response, bytes } = await upstream(snapshot.baseUrl + endpoint, { method: 'POST', headers, body: payload }, snapshot.apiKey, Math.ceil(input.count * limits.image * 4 / 3) + 65536, signal);
        const data = parseJson(bytes);
        assert(Array.isArray(data?.data) && data.data.length > 0 && data.data.length <= input.count, '生图服务未返回有效图片，或返回数量超出请求。', 502);
        const files = [];
        for (const [index, output] of data.data.entries()) {
          let image;
          if (typeof output?.b64_json === 'string' && output.b64_json) {
            assert(output.b64_json.length <= Math.ceil(limits.image * 4 / 3) + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(output.b64_json), '生成图片编码无效或过大。', 502);
            image = Buffer.from(output.b64_json, 'base64');
          } else if (typeof output?.url === 'string') {
            let url;
            try { url = new URL(output.url, snapshot.baseUrl + '/'); } catch { throw new HttpError(502, '生成图片地址不正确。'); }
            assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password, '生成图片地址不正确。', 502);
            ({ bytes: image } = await upstream(url, {}, snapshot.apiKey, limits.image, signal));
          } else throw new HttpError(502, '生图服务未返回可读取的图片。');
          const format = identify(image);
          assert(image.length <= limits.image && format?.type === 'image', '生成结果不是有效图片，或超过 20 MB。', 502);
          files.push(new File([image], `生成图片-${index + 1}.${format.ext}`, { type: format.mime }));
        }
        const upstreamId = data.id || response.headers.get('x-request-id');
        const providerResultId = typeof upstreamId === 'string' && upstreamId.length <= 180 && !upstreamId.includes(snapshot.apiKey) ? upstreamId : null;
        return generations.record({ id, ...params, model: model.name, ratio: ratioFor(input.width, input.height), provider: 'OpenAI-compatible', providerResultId, requestId, requestHash }, files, author);
      };
      let started = false;
      const run = async () => {
        const existing = await generations.get(id);
        if (existing) { assert(existing.authorId === author.id && existing.requestHash === requestHash, '相同请求编号的参数不一致。', 409); return existing; }
        const snapshot = config, model = snapshot.models.find(model => model.id === modelId);
        assert(snapshot.apiKey && snapshot.models.length, '管理员尚未配置生图服务。', 503);
        assert(model, '该模型未启用，请重新选择。');
        assert(active < 2, '生图服务繁忙，请等待当前任务完成。', 429);
        started = true; active++;
        try { return await generateImages(snapshot, model); }
        finally { active--; }
      };
      const promise = run().then(result => { requests.delete(key); return result; }, error => {
        // Keep failures after dispatch so a replay cannot charge for an uncertain result twice.
        if (!started) requests.delete(key);
        throw error;
      });
      requests.set(key, { hash: requestHash, promise });
      return promise;
    }
  };
}
