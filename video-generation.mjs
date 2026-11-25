import { mkdir, readFile, writeFile, rename, unlink, readdir, copyFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, identify, limits } from './storage.mjs';
import { readBounded, redact, upstreamDetail } from './generation-service.mjs';

const model = 'muse-video', modelName = 'Muse Video';
const defaultBaseUrl = 'http://127.0.0.1:18610/v1';
const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const durations = [5, 6, 8, 10];
const referenceLimit = 28 * 1024 ** 2;
const downloadWindow = 120_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const active = new Set(['accepted', 'submitting', 'queued', 'processing', 'saving']);
const assert = (valid, message, status = 400) => { if (!valid) throw new HttpError(status, message); };
const remove = path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });

async function writeJson(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await remove(temp); }
}

function normalizeSettings(input, current) {
  assert(input && typeof input === 'object', '视频配置不正确。');
  assert(input.baseUrl === undefined || typeof input.baseUrl === 'string', '视频服务地址不正确。');
  const baseUrl = (input.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, '');
  const url = URL.canParse(baseUrl) ? new URL(baseUrl) : null;
  assert(url && ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash,
  '视频服务地址必须是指向本机的 /v1 URL。');
  assert(input.apiKey === undefined || typeof input.apiKey === 'string', 'API Key 不正确。');
  assert(input.enabled === undefined || typeof input.enabled === 'boolean', '启用状态不正确。');
  const supplied = (input.apiKey || '').trim().replace(/^Bearer\s+/i, '').trim();
  const apiKey = input.clearKey === true ? '' : supplied || current.apiKey;
  assert(apiKey.length <= 4096 && /^[\x21-\x7e]*$/.test(apiKey), 'API Key 不正确。');
  return { baseUrl: url.origin + '/v1', apiKey, enabled: input.enabled ?? current.enabled };
}

function field(value, max, label) {
  assert(typeof value === 'string' && value.trim() && value.trim().length <= max, label + '不正确。');
  return value.trim();
}

function mediaPath(value) {
  assert(typeof value === 'string' && URL.canParse(value, defaultBaseUrl), 'Muse 未提供可读取的成片地址。', 502);
  const url = new URL(value, defaultBaseUrl);
  assert(['http:', 'https:'].includes(url.protocol) && /^\/v1\/media\/[A-Za-z0-9_-]+\.(mp4|webm)$/i.test(url.pathname),
    'Muse 返回的成片地址不受支持。', 502);
  return url.pathname.slice(3);
}

export function createVideoGeneration(storageRoot, generations, { fetchImpl = fetch, pollMs = 5000, waitMs = 15 * 60_000 } = {}) {
  const directory = join(storageRoot, 'video-jobs'), configPath = join(storageRoot, 'video-generation-config.json');
  const jobs = new Map(), lifetime = new AbortController();
  let config = { baseUrl: defaultBaseUrl, apiKey: '', enabled: false };
  let queue = Promise.resolve(), advancing = false, timer;
  const jobPath = job => join(directory, job.id + '.json');
  const refPath = (job, index) => join(directory, job.id + '-ref-' + index);
  const current = () => [...jobs.values()].find(job => active.has(job.status));
  const settings = () => ({ baseUrl: config.baseUrl, enabled: config.enabled, hasApiKey: !!config.apiKey, available: config.enabled && !!config.apiKey });
  const view = job => ({ id: job.id, title: job.title, model: job.model, category: job.category, ratio: job.ratio, duration: job.duration,
    status: job.status, progress: job.progress, created: job.created,
    generationId: job.status === 'succeeded' ? job.generationId : null, error: job.error || null });

  function ownedJob(id, authorId) {
    const job = jobs.get(id);
    assert(job?.authorId === authorId && job.status !== 'deleted', '视频任务不存在。', 404);
    return job;
  }

  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function update(job, fields) {
    const next = { ...job, ...fields };
    await writeJson(jobPath(next), next);
    jobs.set(next.id, next);
    return next;
  }

  async function clearReferences(job) {
    await Promise.all(job.references.map((_, index) => remove(refPath(job, index))));
  }

  async function finish(job, status, error = '') {
    await update(job, { status, error, progress: status === 'succeeded' ? 100 : job.progress });
    await clearReferences(job);
  }

  const ready = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { config = normalizeSettings(JSON.parse(await readFile(configPath, 'utf8')), config); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取视频配置，请检查 video-generation-config.json。'); }
    const files = await readdir(directory);
    for (const name of files) {
      if (!/^video-[0-9a-f-]{36}\.json$/.test(name)) continue;
      const job = JSON.parse(await readFile(join(directory, name), 'utf8'));
      jobs.set(job.id, job);
      if (job.status === 'submitting') await finish(job, 'submission_unknown', '提交结果待确认，请先在 Muse 检查是否已接收任务。');
      else if (job.status !== 'accepted' && job.status !== 'deleted') await clearReferences(job);
    }
    for (const name of files) {
      const staged = /^(video-[0-9a-f-]{36})(?:-ref-[0-3]|\.part|\.json\.[0-9a-f-]{36}\.tmp)$/.exec(name);
      if (staged && (/\.tmp$|\.part$/.test(name) || !jobs.has(staged[1]))) await remove(join(directory, name));
    }
  })();

  async function request(path, snapshot, timeout, payload) {
    return fetchImpl(snapshot.baseUrl + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + snapshot.apiKey, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]), redirect: 'error'
    });
  }

  async function json(path, snapshot, timeout, payload) {
    const response = await request(path, snapshot, timeout, payload);
    const bytes = await readBounded(response, 1024 ** 2, 'Muse');
    if (!response.ok) throw new HttpError(response.status, redact(upstreamDetail(bytes), snapshot.apiKey) || 'Muse 请求失败（HTTP ' + response.status + '）。');
    try { return JSON.parse(bytes); }
    catch { throw new HttpError(502, 'Muse 返回了无效的任务响应。'); }
  }

  async function saveMedia(job, snapshot) {
    const existing = await generations.get(job.generationId);
    if (existing) return;
    const response = await request(job.mediaPath, snapshot, Math.min(60_000, Math.max(1_000, job.downloadUntil - Date.now())));
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status, 'Muse 成片下载失败（HTTP ' + response.status + '）。');
    }
    const reader = response.body?.getReader();
    assert(reader, 'Muse 没有返回成片。', 502);
    const path = join(directory, job.id + '.part');
    let handle, size = 0;
    const hash = createHash('sha256');
    try {
      assert(Number(response.headers.get('content-length') || 0) <= limits.video, '生成视频超过 100 MiB。', 413);
      handle = await open(path, 'w', 0o600);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        assert(size <= limits.video, '生成视频超过 100 MiB。', 413);
        hash.update(value);
        await handle.writeFile(value);
      }
      await handle.close();
      handle = null;
      lifetime.signal.throwIfAborted();
      await generations.recordVideo(job, { path, size, hash: hash.digest('hex') });
    } finally {
      await reader.cancel().catch(() => {});
      await handle?.close();
      await remove(path);
    }
  }

  async function advance(job, snapshot) {
    if (job.status === 'accepted') {
      const payload = { model, prompt: job.prompt, size: job.ratio, duration: job.duration };
      if (!['16:9', '9:16'].includes(job.ratio)) payload.extra = '画面宽高比为 ' + job.ratio;
      if (job.references.length) payload.images = await Promise.all(job.references.map(async (mime, index) =>
        'data:' + mime + ';base64,' + (await readFile(refPath(job, index))).toString('base64')));
      job = await update(job, { status: 'submitting', deadline: Date.now() + waitMs });
      try {
        const result = await json('/videos', snapshot, 60_000, payload);
        lifetime.signal.throwIfAborted();
        const id = result?.id || result?.task_id;
        assert(typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !id.includes(snapshot.apiKey), 'Muse 未返回可查询的任务编号。', 502);
        job = await update(job, { status: 'queued', upstreamId: id, progress: 10, deadline: Date.now() + waitMs });
      } catch (error) {
        if (lifetime.signal.aborted) return;
        if (error instanceof HttpError && error.status < 500) await finish(job, 'failed', error.message);
        else await finish(job, 'submission_unknown', '提交结果待确认，请先在 Muse 检查是否已接收任务。');
        return;
      }
      await clearReferences(job);
      return;
    }
    if (job.status === 'saving') {
      try { await saveMedia(job, snapshot); }
      catch (error) {
        if (lifetime.signal.aborted) return;
        const permanent = error instanceof HttpError && error.status < 500 && error.status !== 429;
        if (permanent || Date.now() >= job.downloadUntil) {
          await finish(job, 'failed', error instanceof HttpError ? redact(error.message, snapshot.apiKey) : '无法保存 Muse 成片。');
        }
        return;
      }
      if (!lifetime.signal.aborted) await finish(job, 'succeeded');
      return;
    }
    let data;
    try { data = await json('/videos/' + job.upstreamId, snapshot, 15_000); }
    catch (error) {
      if (lifetime.signal.aborted) return;
      if (error instanceof HttpError && error.status < 500 && error.status !== 429) await finish(job, 'failed', error.message);
      else if (Date.now() >= job.deadline) await finish(job, 'failed', '等待 Muse 生成超时，请先在 Muse 查看任务状态。');
      return;
    }
    if (lifetime.signal.aborted) return;
    const status = data?.status;
    if (status === 'completed') {
      let path;
      try { path = mediaPath(data.url || data.result?.url || data.video?.url); }
      catch (error) { await finish(job, 'failed', error.message); return; }
      await update(job, { status: 'saving', progress: 95, mediaPath: path, downloadUntil: Date.now() + downloadWindow });
    } else if (['failed', 'canceled', 'cancelled'].includes(status)) {
      await finish(job, 'failed', redact(upstreamDetail(Buffer.from(JSON.stringify(data.error || data.detail || ''))), snapshot.apiKey) || 'Muse 生成失败。');
    } else if (Date.now() >= job.deadline) {
      await finish(job, 'failed', '等待 Muse 生成超时，请先在 Muse 查看任务状态。');
    } else if (status === 'processing') {
      const progress = Math.min(94, Math.max(job.progress, Number(data.progress) || 0));
      if (job.status !== status || job.progress !== progress) await update(job, { status, progress });
    }
  }

  async function tick() {
    const job = current();
    if (!job || advancing || lifetime.signal.aborted) return;
    advancing = true;
    const snapshot = config;
    try { await advance(job, snapshot); }
    catch (error) {
      if (!lifetime.signal.aborted) {
        console.error('Video job storage failed:', job.id, error.code || error.name);
        if (jobs.get(job.id)?.status === 'accepted') await finish(job, 'failed', '无法读取视频任务的参考图。')
          .catch(failure => console.error('Video job update failed:', job.id, failure.code || failure.name));
        else if (jobs.get(job.id)?.status === 'submitting') await finish(job, 'submission_unknown', '提交结果待确认，请先在 Muse 检查是否已接收任务。')
          .catch(failure => console.error('Video job update failed:', job.id, failure.code || failure.name));
      }
    } finally { advancing = false; }
  }

  return {
    ready, settings,
    start() { timer = setInterval(() => void tick(), pollMs); timer.unref(); void tick(); },
    close() { clearInterval(timer); lifetime.abort(); },
    async configure(input) {
      return serial(async () => {
        const next = normalizeSettings(input, config);
        assert(!current() || next.baseUrl === config.baseUrl && next.apiKey === config.apiKey, '任务进行中，请稍后再修改视频服务地址或密钥。', 409);
        assert(!next.enabled || next.apiKey, '请先填写 API Key。');
        await writeJson(configPath, next);
        config = next;
        return settings();
      });
    },
    async test(input) {
      const snapshot = normalizeSettings(input, config);
      assert(snapshot.apiKey, '请先填写 API Key。');
      let data;
      try { data = await json('/models', snapshot, 10_000); }
      catch (error) { throw new HttpError(502, error instanceof HttpError ? error.message : '无法连接 Muse 视频服务。'); }
      assert(Array.isArray(data?.data) && data.data.some(item => item?.id === model), 'Muse 模型列表中未找到 muse-video。', 502);
      return { model };
    },
    async submit(input, files, author) {
      assert(input && typeof input === 'object' && typeof input.requestId === 'string' && uuid.test(input.requestId), '请求编号不正确。');
      const ratio = input.ratio ?? '16:9', duration = input.duration ?? 5;
      assert(ratios.includes(ratio) && durations.includes(duration), '视频画幅或时长不受支持。');
      const params = { title: input.title ? field(input.title, 70, '创作名称') : '未命名创作', prompt: field(input.prompt, 2000, '提示词'),
        category: field(input.category, 30, '风格分类'), ratio, duration };
      assert(files.length <= 4, '最多添加 4 张参考图。');
      assert(files.reduce((size, file) => size + file.size, 0) <= referenceLimit, '视频参考图合计不能超过 28 MiB。', 413);
      const references = [];
      for (const file of files) {
        assert(file.size > 0 && file.size <= limits.image, '视频参考图单张不能超过 20 MiB。', 413);
        const handle = await open(file.tempPath, 'r');
        const bytes = Buffer.alloc(Math.min(file.size, 256));
        try { await handle.read(bytes); } finally { await handle.close(); }
        const format = identify(bytes);
        assert(format?.type === 'image' && (!file.type || file.type === format.mime || file.type === 'application/octet-stream'), '参考图必须是有效的 JPEG、PNG、WebP 或 GIF。', 415);
        references.push(format.mime);
      }
      const requestHash = createHash('sha256').update(JSON.stringify([params, files.map(file => file.hash)])).digest('hex');
      return serial(async () => {
        const previous = [...jobs.values()].find(job => job.authorId === author.id && job.requestId === input.requestId);
        if (previous) {
          assert(previous.status !== 'deleted', '这条视频任务已删除，请先在 Muse 核对原请求。', 409);
          assert(previous.requestHash === requestHash, '相同请求编号的参数不一致。', 409);
          return view(previous);
        }
        assert(settings().available, '管理员尚未启用视频服务。', 503);
        assert(!current(), '已有视频任务进行中，请等待完成。', 429);
        const job = { id: 'video-' + randomUUID(), generationId: 'generation-' + randomUUID(), requestId: input.requestId, requestHash,
          authorId: author.id, author: author.nickname, model: modelName, modelId: model, ...params, references, status: 'accepted', progress: 0, created: Date.now() };
        try {
          for (const [index, file] of files.entries()) await copyFile(file.tempPath, refPath(job, index));
          await update(job, {});
        } catch (error) {
          await clearReferences(job);
          throw error;
        }
        void tick();
        return view(job);
      });
    },
    list(authorId) {
      return [...jobs.values()].filter(job => job.authorId === authorId && job.status !== 'succeeded' && job.status !== 'deleted')
        .sort((a, b) => b.created - a.created).slice(0, 20).map(view);
    },
    get(id, authorId) {
      return view(ownedJob(id, authorId));
    },
    remove(id, authorId) {
      return serial(async () => {
        const job = ownedJob(id, authorId);
        assert(job.status === 'failed' || job.status === 'submission_unknown', '只能删除失败或提交结果待确认的视频任务。', 409);
        await clearReferences(job);
        // 保留原请求编号，防止网络重试重复派发。
        const deleted = { id, authorId, requestId: job.requestId, status: 'deleted' };
        await writeJson(jobPath(job), deleted);
        jobs.set(id, deleted);
        return { deleted: id };
      });
    }
  };
}
