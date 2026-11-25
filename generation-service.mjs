import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, identify, limits } from './storage.mjs';

const defaultBaseUrl = 'http://127.0.0.1:38650/v1';
const defaultModelCategory = 'GPT Image';
const museModel = { id: 'muse-image', name: 'Muse Image', category: 'Muse Image', maxCount: 1 };
const defaultMuse = { baseUrl: 'http://127.0.0.1:18610/v1', apiKey: '', enabled: false };
const requestIdRule = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const assert = (ok, message, status = 400) => { if (!ok) throw new HttpError(status, message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function generationId(authorId, requestId) {
  assert(typeof requestId === 'string' && requestIdRule.test(requestId), '请求编号不正确。');
  const hex = hash(authorId + ':' + requestId).slice(0, 32);
  return 'generation-' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
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
function serviceKey(input, previous) {
  assert(input.apiKey === undefined || typeof input.apiKey === 'string', 'API Key 不正确。');
  const supplied = (input.apiKey || '').trim().replace(/^Bearer\s+/i, '').trim();
  const apiKey = input.clearKey === true ? '' : supplied || previous;
  assert(apiKey.length <= 4096 && !/[\r\n]/.test(apiKey), 'API Key 不正确。');
  return apiKey;
}
function normalizeMuse(input, previous) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'Muse 生图配置不正确。');
  const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
  const url = new URL(baseUrl);
  assert(['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/v1', 'Muse 生图地址必须是指向本机的 /v1 URL。');
  assert(input.enabled === undefined || typeof input.enabled === 'boolean', 'Muse 生图启用状态不正确。');
  const apiKey = serviceKey(input, previous.apiKey);
  assert(!apiKey || /^[\x21-\x7e]+$/.test(apiKey), 'Muse 生图 API Key 不正确。');
  return { baseUrl, apiKey, enabled: input.enabled ?? previous.enabled };
}
function normalizeConfig(input, previous) {
  assert(input && typeof input === 'object', '生图配置不正确。');
  const baseUrl = serviceUrl(input.baseUrl ?? previous.baseUrl);
  const apiKey = serviceKey(input, previous.apiKey);
  const models = input.models ?? previous.models;
  assert(Array.isArray(models) && models.length <= 50, '最多启用 50 个模型。');
  const normalized = models.map(model => {
    const id = requiredText(model?.id, 200, '模型 ID');
    const name = requiredText(model.name || id.slice(0, 40), 40, '模型名称');
    const category = requiredText(model.category || defaultModelCategory, 30, '模型分类');
    return { id, name, category };
  });
  assert(new Set(normalized.map(model => model.id)).size === normalized.length, '模型 ID 不能重复。');
  const defaultModel = input.defaultModel ?? previous.defaultModel;
  assert(typeof defaultModel === 'string' && (!normalized.length ? !defaultModel : normalized.some(model => model.id === defaultModel)), '请选择已启用的默认模型。');
  const muse = input.muse === undefined ? previous.muse : normalizeMuse(input.muse, previous.muse);
  if (muse.enabled) {
    assert(muse.apiKey, '请先填写 Muse 生图 API Key。');
    assert(!normalized.some(model => model.id === museModel.id), '请先取消通用生图服务中已启用的 muse-image 模型。');
  }
  return { baseUrl, apiKey, models: normalized, defaultModel, muse };
}

async function removeFile(path) {
  await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function writePrivate(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
  finally { await removeFile(temp); }
}
export function redact(value, key) {
  return String(value || '').split(key || '\0').join('[已隐藏]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').slice(0, 300);
}
export async function readBounded(response, max, service = '生图服务') {
  assert(Number(response.headers.get('content-length') || 0) <= max, service + '返回内容过大。', 502);
  const reader = response.body?.getReader();
  assert(reader, service + '没有返回内容。', 502);
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      assert(size <= max, service + '返回内容过大。', 502);
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
// 生图服务可能用多种形状回报失败原因，这里尽量取出人可读的原文。
function messageFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) { for (const item of value) { const text = messageFrom(item); if (text) return text; } return ''; }
  if (!value || typeof value !== 'object') return '';
  for (const key of ['message', 'msg', 'text', 'content', 'detail', 'description', 'reason', 'error']) {
    const text = messageFrom(value[key]);
    if (text) return text;
  }
  return '';
}
export function upstreamDetail(bytes) {
  const raw = bytes.toString('utf8').trim();
  if (!raw) return '';
  try { return messageFrom(JSON.parse(raw)); }
  catch {
    // 非 JSON 的错误正文（纯文本）直接展示；HTML 错误页没有可读信息。
    if (raw.startsWith('<')) return '';
    return raw.split('\n').map(line => line.trim()).find(Boolean) || '';
  }
}

export function createGenerationService(storageRoot, generations, { fetchImpl = fetch, timeoutMs = 240000, musePollMs = 3000 } = {}) {
  const path = join(storageRoot, 'generation-config.json');
  const musePath = join(storageRoot, 'muse-image-job.json');
  const lifetime = new AbortController();
  let config = { baseUrl: defaultBaseUrl, apiKey: '', models: [], defaultModel: '', muse: defaultMuse };
  let activeMuse = null;
  const museJobs = new Map();
  const ready = (async () => {
    try { config = normalizeConfig(JSON.parse(await readFile(path, 'utf8')), config); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取生图配置，请检查 generation-config.json。'); }
    try { activeMuse = JSON.parse(await readFile(musePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 Muse 生图任务，请检查 muse-image-job.json。'); }
    if (activeMuse) museJobs.set(activeMuse.id, activeMuse);
  })();
  let configQueue = Promise.resolve();
  let active = 0;
  const requests = new Map();
  function publicConfig(admin = false, canUseMuse = false) {
    const muse = config.muse;
    if (admin) return { available: !!(config.apiKey && config.models.length), models: config.models, defaultModel: config.defaultModel,
      baseUrl: config.baseUrl, hasApiKey: !!config.apiKey, muse: { baseUrl: muse.baseUrl, enabled: muse.enabled, hasApiKey: !!muse.apiKey } };
    if (canUseMuse && muse.enabled) {
      const models = config.apiKey ? [...config.models, museModel] : [museModel];
      return { available: true, models, defaultModel: config.apiKey && config.defaultModel || museModel.id };
    }
    return { available: !!(config.apiKey && config.models.length), models: config.models, defaultModel: config.defaultModel };
  }
  async function upstream(url, options, key, max, signal) {
    let response, bytes;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal });
      bytes = await readBounded(response, response.ok ? max : 65536);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const failure = new HttpError(signal.aborted ? 504 : 502, signal.aborted ? '生图服务请求超时，请先检查生成记录，避免重复生成。' : '无法连接生图服务，请检查服务地址和运行状态。');
      failure.retryable = true;
      throw failure;
    }
    if (!response.ok) {
      const detail = redact(upstreamDetail(bytes), key);
      const message = response.status === 401 || response.status === 403 ? '生图服务密钥无效或无权限，请联系管理员。'
        : response.status === 429 ? '生图服务请求受限，请稍后再试。' + (detail ? detail : '')
        : '生图服务拒绝请求（HTTP ' + response.status + '）' + (detail ? '：' + detail : '。');
      const failure = new HttpError(response.status === 429 ? 429 : 502, message);
      failure.retryable = response.status === 429 || response.status >= 500;
      throw failure;
    }
    return { response, bytes };
  }
  function parseJson(bytes) {
    try { return JSON.parse(bytes.toString()); } catch { throw new HttpError(502, '生图服务返回的 JSON 无法解析。'); }
  }
  function museSignal(ms) {
    return AbortSignal.any([lifetime.signal, AbortSignal.timeout(ms)]);
  }
  function imageFile(image, index) {
    const format = identify(image);
    assert(image.length <= limits.image && format?.type === 'image', '生成结果不是有效图片，或超过 20 MB。', 502);
    return new File([image], `生成图片-${index + 1}.${format.ext}`, { type: format.mime });
  }
  function publicMuseJob(job) {
    return { job: { requestId: job.record.requestId, status: job.error ? 'failed' : job.status,
      ...(job.error ? { error: job.error.message } : {}) } };
  }
  async function finishMuse(job, snapshot) {
    try {
      if (await generations.get(job.id)) return;
      const headers = { Authorization: 'Bearer ' + snapshot.apiKey };
      const read = async (url, max, timeout) => {
        // Bound connection failures independently of the queue and generation time configured in Muse.
        const retryUntil = Date.now() + 15 * 60_000;
        while (true) {
          try { return await upstream(url, { headers }, snapshot.apiKey, max, museSignal(timeout)); }
          catch (error) {
            const remaining = retryUntil - Date.now();
            if (!error.retryable || remaining <= 0 || lifetime.signal.aborted) throw error;
            await delay(Math.min(musePollMs, remaining), undefined, { signal: lifetime.signal, ref: false });
          }
        }
      };
      while (true) {
        const { bytes } = await read(snapshot.baseUrl + '/images/tasks/' + job.upstreamId, 128 * 1024, 15000);
        const result = parseJson(bytes);
        if (result.status === 'completed') {
          const output = result.data?.[0]?.url || result.result?.url || result.url;
          const url = typeof output === 'string' && URL.canParse(output, snapshot.baseUrl) ? new URL(output, snapshot.baseUrl) : null;
          assert(url && ['http:', 'https:'].includes(url.protocol) && /^\/v1\/media\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/i.test(url.pathname), 'Muse 未返回可读取的图片地址。', 502);
          const { bytes: image } = await read(new URL(url.pathname, snapshot.baseUrl), limits.image, 30000);
          lifetime.signal.throwIfAborted();
          await generations.record(job.record, [imageFile(image, 0)], job.author);
          return;
        }
        if (['failed', 'canceled', 'cancelled'].includes(result.status)) {
          throw new HttpError(502, redact(messageFrom(result.error || result.detail), snapshot.apiKey) || 'Muse 生图失败。');
        }
        assert(['queued', 'processing'].includes(result.status), 'Muse 返回的图片任务状态不正确。', 502);
        job.status = result.status;
        await delay(musePollMs, undefined, { signal: lifetime.signal, ref: false });
      }
    } catch (error) {
      if (!lifetime.signal.aborted) {
        if (!(error instanceof HttpError)) console.error('Muse image job failed:', job.id, error.code || error.name);
        job.error = error instanceof HttpError ? error : new HttpError(500, '无法保存 Muse 生成图片。');
      }
    } finally {
      if (!lifetime.signal.aborted) {
        await removeFile(musePath).catch(error => console.error('Muse image job cleanup failed:', error.code || error.name));
        activeMuse = null;
        if (!job.error) museJobs.delete(job.id);
      }
    }
  }
  async function submitMuse(id, params, requestId, requestHash, references, author) {
    assert(params.count === 1, 'Muse Image 每次生成 1 张图片。');
    const existing = await generations.get(id);
    if (existing) {
      assert(existing.authorId === author.id && existing.requestHash === requestHash, '相同请求编号的参数不一致。', 409);
      return { generation: existing };
    }
    await configQueue;
    const previous = museJobs.get(id);
    if (previous) {
      assert(previous.record.requestHash === requestHash, '相同请求编号的参数不一致。', 409);
      if (previous.error) throw previous.error;
      await previous.acceptance;
      return publicMuseJob(previous);
    }
    const snapshot = config.muse;
    assert(snapshot.enabled, '管理员尚未启用 Muse 生图。', 503);
    assert(!activeMuse, '已有 Muse 生图任务，请等待任务完成。', 429);
    const ratio = ratioFor(params.width, params.height);
    const job = { id, status: 'queued', author: { id: author.id, nickname: author.nickname },
      record: { id, ...params, model: museModel.category, modelName: museModel.name, ratio, provider: 'Muse', requestId, requestHash } };
    activeMuse = job;
    museJobs.set(id, job);
    const accept = async () => {
      try {
        const prompt = params.prompt + (params.negative ? '\n\n不希望出现：\n' + params.negative : '');
        const body = JSON.stringify({ model: museModel.id, prompt, n: 1, aspect_ratio: ratio, response_format: 'url',
          ...(references.length ? { images: references.map(ref => `data:${ref.format.mime};base64,${ref.bytes.toString('base64')}`) } : {}) });
        const { bytes } = await upstream(snapshot.baseUrl + '/images/tasks', { method: 'POST', body,
          headers: { Authorization: 'Bearer ' + snapshot.apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': id } }, snapshot.apiKey, 65536, museSignal(45000));
        const { id: upstreamId } = parseJson(bytes);
        assert(typeof upstreamId === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(upstreamId), 'Muse 未返回可查询的图片任务编号。', 502);
        job.upstreamId = upstreamId;
        job.record.providerResultId = upstreamId.includes(snapshot.apiKey) ? null : upstreamId;
        const { acceptance, ...receipt } = job;
        await writePrivate(musePath, receipt);
        void finishMuse(job, snapshot);
      } catch (error) {
        activeMuse = null;
        museJobs.delete(id);
        throw error;
      }
    };
    job.acceptance = accept();
    await job.acceptance;
    delete job.acceptance;
    return publicMuseJob(job);
  }
  return {
    museAdminConnection() { return config.muse.apiKey ? { baseUrl: config.muse.baseUrl, apiKey: config.muse.apiKey } : null; },
    ready,
    start() { if (activeMuse) void finishMuse(activeMuse, config.muse); },
    close() { lifetime.abort(); },
    async settings(admin = false, canUseMuse = false) { await ready; return publicConfig(admin, canUseMuse); },
    async museStatus(requestId, author) {
      await ready;
      const id = generationId(author.id, requestId);
      const job = museJobs.get(id);
      if (job) return publicMuseJob(job);
      const generation = await generations.get(id);
      assert(generation?.authorId === author.id && generation.modelId === museModel.id && generation.provider === 'Muse', '找不到 Muse 生图任务。', 404);
      return { generation };
    },
    async save(input) {
      await ready;
      const save = async () => {
        const next = normalizeConfig(input, config);
        assert(!activeMuse || next.muse.baseUrl === config.muse.baseUrl && next.muse.apiKey === config.muse.apiKey, 'Muse 生图任务进行中，请完成后再更改地址或密钥。', 409);
        await writePrivate(path, next);
        config = next;
        return publicConfig(true);
      };
      const result = configQueue.then(save); configQueue = result.catch(() => {}); return result;
    },
    async models(input) {
      await ready;
      if (input?.muse !== undefined) {
        const candidate = normalizeMuse(input.muse, config.muse);
        assert(candidate.apiKey, '请先填写 Muse 生图 API Key。');
        const { bytes } = await upstream(candidate.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + candidate.apiKey } }, candidate.apiKey, 65536, AbortSignal.timeout(10000));
        const data = parseJson(bytes);
        assert(Array.isArray(data?.data) && data.data.some(model => model?.id === museModel.id), 'Muse 模型列表中未找到 muse-image。', 502);
        return { model: museModel.id };
      }
      const candidate = normalizeConfig({ ...input, models: config.models, defaultModel: config.defaultModel }, config);
      assert(candidate.apiKey, '请先填写 API Key。');
      const { bytes } = await upstream(candidate.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + candidate.apiKey } }, candidate.apiKey, 2 * 1024 ** 2, AbortSignal.timeout(Math.min(timeoutMs, 15000)));
      const data = parseJson(bytes);
      assert(Array.isArray(data?.data), '模型列表格式不正确。', 502);
      return { models: data.data.filter(model => typeof model?.id === 'string' && model.id.trim() && model.id.length <= 200).map(model => ({ id: model.id, name: model.id.slice(0, 40), category: defaultModelCategory })) };
    },
    async generate(input, uploads, author) {
      await ready;
      assert(input && typeof input === 'object', '生成参数不正确。');
      const requestId = input.requestId;
      const id = generationId(author.id, requestId);
      const modelId = requiredText(input.modelId, 200, '模型 ID');
      const useMuse = modelId === museModel.id && !config.models.some(model => model.id === modelId);
      if (useMuse) assert(author.role === 'admin', 'Muse 生图仅向管理员开放。', 403);
      assert(input.modelCategory === undefined || typeof input.modelCategory === 'string', '模型分类不正确。');
      const requestedCategory = (input.modelCategory || '').trim();
      assert(requestedCategory.length <= 30, '模型分类不正确。');
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
      const params = { title, prompt, negative, category, modelId, modelCategory: requestedCategory, width: input.width, height: input.height, count: input.count };
      const requestHash = hash(JSON.stringify({ ...params, references: references.map(file => file.hash) }));
      const previous = requests.get(id);
      if (previous) { assert(previous.hash === requestHash, '相同请求编号的参数不一致。', 409); return { generation: await previous.promise }; }
      if (useMuse) return submitMuse(id, params, requestId, requestHash, references, author);
      assert(!museJobs.has(id), '相同请求编号的参数不一致。', 409);
      const generateImages = async (snapshot, model) => {
        const signal = AbortSignal.timeout(timeoutMs);
        // 生成记录归入模型分类，未指定时使用管理员为该模型配置的分类。
        const allowed = new Set([defaultModelCategory, ...snapshot.models.map(item => item.category)]);
        const group = allowed.has(requestedCategory) ? requestedCategory : model.category;
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
          files.push(imageFile(image, index));
        }
        const upstreamId = data.id || response.headers.get('x-request-id');
        const providerResultId = typeof upstreamId === 'string' && upstreamId.length <= 180 && !upstreamId.includes(snapshot.apiKey) ? upstreamId : null;
        return generations.record({ id, ...params, model: group, modelName: model.name, ratio: ratioFor(input.width, input.height), provider: 'OpenAI-compatible', providerResultId, requestId, requestHash }, files, author);
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
      const promise = run().then(result => { requests.delete(id); return result; }, error => {
        // Keep failures after dispatch so a replay cannot charge for an uncertain result twice.
        if (!started) requests.delete(id);
        throw error;
      });
      requests.set(id, { hash: requestHash, promise });
      return { generation: await promise };
    }
  };
}
