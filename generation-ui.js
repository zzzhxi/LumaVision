const videoConfigPath = '/api/admin/video-generation-config';
const videoRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const videoDurations = [5, 6, 8, 10];
const appPath = new URL('./', import.meta.url).pathname;

export function createGenerationUI({ request, session, escape, toast, completed, videoAccepted, login }) {
  const dialog = document.querySelector('#generation-settings');
  const running = new Set();
  let refreshCreator;
  dialog.addEventListener('close', () => { dialog.replaceChildren(); });
  async function openSettings() {
    if (session().user?.role !== 'admin') return;
    const epoch = session().epoch;
    let settings;
    try { settings = await request('/api/admin/generation-config'); }
    catch (error) { toast(error.message); return; }
    if (session().epoch !== epoch) return;
    dialog.innerHTML = `<form class="mini-form generation-form"><button type="button" class="icon-button close" data-close="generation-settings" aria-label="关闭生图服务设置">×</button><p class="eyebrow">IMAGE SERVICE</p><h2 id="generation-settings-title">生图服务</h2><p class="generation-help">由管理员统一配置，登录用户共用。模型列表可能包含不能生图的模型，请只启用已确认的图片模型。别称显示在创作台的模型选择里，模型分类决定生成结果归入灵感库的哪个模型分组。</p><label class="field">API Base URL<input name="baseUrl" type="url" required value="${escape(settings.baseUrl)}" placeholder="http://127.0.0.1:38650/v1"></label><label class="field">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${settings.hasApiKey ? '已配置；留空保留原密钥' : '输入 Key 或 Bearer Key'}"></label><label class="generation-check"><input name="clearKey" type="checkbox">清除已保存的密钥</label><button type="button" class="button soft" id="generation-test">测试连接并读取模型</button><div class="field"><span>已启用的模型</span><div id="generation-models" class="generation-models"></div></div><div class="generation-manual"><label class="field">手动添加模型 ID<input id="generation-model-id" maxlength="200" placeholder="精确的接口模型 ID"></label><button type="button" class="button soft" id="generation-add-model">添加</button></div><label class="field">默认模型<select name="defaultModel"></select></label><p id="generation-settings-status" role="status" aria-live="polite"></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="generation-settings">取消</button><button type="submit" class="button dark">保存配置</button></div></form>`;
    const form = dialog.querySelector('form'), status = form.querySelector('[role="status"]');
    const models = new Map(settings.models.map(model => [model.id, model]));
    const enabled = new Set(settings.models.map(model => model.id));
    let preferred = settings.defaultModel;
    const isCurrent = () => form.isConnected && session().epoch === epoch;
    // 模型分类必须与灵感库的模型筛选一致，生成结果才能落到对应分组。
    const categoryOptions = () => {
      const list = (document.querySelector('.model-group[data-categories]')?.dataset.categories || '').split(',').map(item => item.trim()).filter(Boolean);
      return list.length ? list : ['GPT Image'];
    };
    function renderModels() {
      const options = categoryOptions();
      form.querySelector('#generation-models').innerHTML = [...models.values()].map(model => {
        const categories = options.includes(model.category) ? options : [model.category, ...options];
        return `<div class="generation-model"><label class="generation-check"><input type="checkbox" value="${escape(model.id)}" ${enabled.has(model.id) ? 'checked' : ''}><span title="${escape(model.id)}">${escape(model.id)}</span></label><label class="generation-model-field">别称<input data-model-alias="${escape(model.id)}" maxlength="40" value="${escape(model.name)}"></label><label class="generation-model-field">模型分类<select data-model-category="${escape(model.id)}">${categories.map(category => `<option value="${escape(category)}" ${category === model.category ? 'selected' : ''}>${escape(category)}</option>`).join('')}</select></label></div>`;
      }).join('') || '<span class="generation-help">读取列表或手动添加一个模型。</span>';
      const select = form.elements.defaultModel;
      const selected = [...models.values()].filter(model => enabled.has(model.id));
      if (!enabled.has(preferred)) preferred = selected[0]?.id || '';
      select.innerHTML = selected.map(model => `<option value="${escape(model.id)}" title="${escape(model.id)}">${escape(model.name)}</option>`).join('') || '<option value="">暂无启用模型</option>';
      select.value = preferred;
    }
    function candidate() { return { baseUrl: form.elements.baseUrl.value.trim(), apiKey: form.elements.apiKey.value, clearKey: form.elements.clearKey.checked }; }
    renderModels();
    const modelList = form.querySelector('#generation-models');
    modelList.addEventListener('change', event => {
      const target = event.target;
      if (target.matches('input[type="checkbox"]')) {
        if (target.checked) enabled.add(target.value); else enabled.delete(target.value);
        preferred = form.elements.defaultModel.value; renderModels(); return;
      }
      const model = models.get(target.dataset.modelCategory);
      if (model) model.category = target.value;
    });
    modelList.addEventListener('input', event => {
      const model = models.get(event.target.dataset.modelAlias);
      if (model) model.name = event.target.value;
    });
    form.elements.defaultModel.addEventListener('change', () => { preferred = form.elements.defaultModel.value; });
    form.querySelector('#generation-add-model').addEventListener('click', () => {
      const input = form.querySelector('#generation-model-id'), id = input.value.trim();
      if (!id) { input.focus(); return; }
      models.set(id, { id, name: id.slice(0, 40), category: 'GPT Image' }); enabled.add(id); input.value = ''; renderModels();
    });
    async function busy(action) {
      form.querySelectorAll('button,input,select').forEach(control => { control.disabled = true; });
      status.textContent = '正在连接服务…';
      try { await action(); }
      catch (error) { if (isCurrent()) status.textContent = error.message; }
      finally { if (isCurrent()) form.querySelectorAll('button,input,select').forEach(control => { control.disabled = false; }); }
    }
    form.querySelector('#generation-test').addEventListener('click', () => busy(async () => {
      const result = await request('/api/admin/generation-models', { method: 'POST', body: candidate() });
      if (!isCurrent()) return;
      for (const model of result.models) if (!models.has(model.id)) models.set(model.id, model);
      renderModels(); status.textContent = `连接成功，读取到 ${result.models.length} 个模型。请选择可生图模型后保存。`;
    }));
    form.addEventListener('submit', event => {
      event.preventDefault();
      busy(async () => {
        const result = await request('/api/admin/generation-config', { method: 'PUT', body: { ...candidate(), models: [...models.values()].filter(model => enabled.has(model.id)), defaultModel: form.elements.defaultModel.value } });
        if (!isCurrent()) return;
        form.elements.apiKey.value = ''; form.elements.clearKey.checked = false;
        form.elements.apiKey.placeholder = result.hasApiKey ? '已配置；留空保留原密钥' : '输入 Key 或 Bearer Key';
        status.textContent = result.available ? '配置已保存，重新打开创作窗口即可使用。' : '配置已保存；填写密钥并启用模型后可生成。';
      });
    });
    dialog.showModal();
  }
  async function openVideoSettings() {
    if (session().user?.role !== 'admin') return;
    const epoch = session().epoch;
    let settings;
    try { settings = await request(videoConfigPath); }
    catch (error) { toast(error.message); return; }
    if (session().epoch !== epoch || dialog.open) return;
    dialog.innerHTML = `<form class="mini-form generation-form">
      <button type="button" class="icon-button close" data-close="generation-settings" aria-label="关闭视频服务设置">×</button>
      <h2 id="generation-settings-title">视频服务</h2>
      <label class="field">API Base URL<input name="baseUrl" type="url" required value="${escape(settings.baseUrl)}"></label>
      <label class="field">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${settings.hasApiKey ? '已配置 · 留空保留原密钥' : 'Muse 管理员签发的平台 Key'}"></label>
      <label class="generation-check"><input name="clearKey" type="checkbox">清除已保存的密钥</label>
      <label class="generation-check"><input name="enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>启用视频生成（仅管理员）</label>
      <button type="button" class="button soft" data-test-video>测试连接</button>
      <p role="status"></p>
      <div class="mini-form-actions"><button type="button" class="button soft" data-close="generation-settings">关闭</button><button type="submit" class="button dark">保存配置</button></div>
    </form>`;
    const form = dialog.querySelector('form'), status = form.querySelector('[role="status"]');
    const fields = form.elements, test = form.querySelector('[data-test-video]'), save = form.querySelector('[type="submit"]');
    async function submit(verify) {
      if (!form.reportValidity()) return;
      const body = { baseUrl: fields.baseUrl.value, apiKey: fields.apiKey.value, clearKey: fields.clearKey.checked, enabled: fields.enabled.checked };
      test.disabled = save.disabled = true;
      status.textContent = verify ? '正在测试连接…' : '正在保存配置…';
      try {
        const result = await request(verify ? '/api/admin/video-generation-test' : videoConfigPath, { method: verify ? 'POST' : 'PUT', body });
        if (session().epoch !== epoch || !form.isConnected) return;
        if (!verify) {
          fields.apiKey.value = '';
          fields.clearKey.checked = false;
          fields.apiKey.placeholder = result.hasApiKey ? '已配置 · 留空保留原密钥' : 'Muse 管理员签发的平台 Key';
        }
        status.textContent = verify ? '连接成功，已找到 Muse Video。' : '视频服务配置已保存。';
      } catch (error) {
        if (session().epoch === epoch && form.isConnected) status.textContent = error.message;
      } finally { test.disabled = save.disabled = false; }
    }
    test.addEventListener('click', () => submit(true));
    form.addEventListener('submit', event => { event.preventDefault(); void submit(false); });
    dialog.showModal();
  }
  async function attachCreator({ draft, getCreative, references, changed }) {
    const form = document.querySelector('#creative-form');
    const modelSelect = form.querySelector('#creative-model'), ratio = form.querySelector('#creative-ratio');
    const button = form.querySelector('#generate-button'), status = form.querySelector('.generation-status');
    const type = form.querySelector('#creative-type'), countField = form.querySelector('#creative-count').closest('.field');
    const prompt = form.querySelector('#creative-prompt'), negative = form.querySelector('.creative-advanced');
    const description = form.closest('.creator-layout').querySelector('.creator-heading p:last-child');
    const draftRatios = ratio.innerHTML;
    let videoRatio = videoRatios.includes(draft.ratio) && draft.type === 'video' ? draft.ratio : '16:9';
    modelSelect.closest('.field').insertAdjacentHTML('afterend', `<label class="field" hidden>目标时长<select id="creative-duration">${videoDurations.map(seconds => `<option value="${seconds}">${seconds} 秒</option>`).join('')}</select></label>`);
    const duration = form.querySelector('#creative-duration');
    duration.value = videoDurations.includes(draft.requestedDuration) ? draft.requestedDuration : 5;
    ratio.addEventListener('change', () => { if (type.value === 'video' && videoRatios.includes(ratio.value)) videoRatio = ratio.value; });
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    modelSelect.closest('.field').insertAdjacentHTML('afterend', '<label class="field">模型分类<select id="creative-model-category"></select></label>');
    const categorySelect = form.querySelector('#creative-model-category');
    const legacySizes = { '3:4': [768, 1024], '4:3': [1024, 768], '16:9': [1536, 864], '9:16': [864, 1536] };
    const savedSize = [draft.width, draft.height];
    const [width, height] = savedSize.every(value => Number.isInteger(value) && value >= 1 && value <= 9999) ? savedSize : Object.hasOwn(legacySizes, draft.ratio) ? legacySizes[draft.ratio] : [1024, 1024];
    ratio.closest('.field').insertAdjacentHTML('afterend', `<div class="generation-dimensions"><label class="field">图片尺寸<select id="creative-size"><option value="1024x1024">正方形 · 1024 × 1024</option><option value="1024x1536">竖图 · 1024 × 1536</option><option value="1536x1024">横图 · 1536 × 1024</option><option value="custom">自定义尺寸</option></select></label><div class="generation-custom-size"><label class="field">宽度（像素）<input id="creative-width" type="number" min="1" max="9999" step="1" value="${width}"></label><label class="field">高度（像素）<input id="creative-height" type="number" min="1" max="9999" step="1" value="${height}"></label></div><p class="generation-help">可用尺寸和数量以所选模型为准。</p></div>`);
    const size = form.querySelector('#creative-size'), dimensions = form.querySelector('.generation-dimensions');
    size.value = ['1024x1024', '1024x1536', '1536x1024'].includes(`${width}x${height}`) ? `${width}x${height}` : 'custom';
    function syncSize() {
      const custom = size.value === 'custom';
      const image = type.value === 'image';
      form.querySelector('.generation-custom-size').hidden = !custom;
      categorySelect.closest('.field').hidden = !image;
      for (const input of dimensions.querySelectorAll('input')) { input.required = custom && image; input.disabled = !custom || !image; }
      if (!image) return;
      if (size.value !== 'custom') {
        const [w, h] = size.value.split('x'); form.querySelector('#creative-width').value = w; form.querySelector('#creative-height').value = h;
      }
      let a = Number(form.querySelector('#creative-width').value), b = Number(form.querySelector('#creative-height').value);
      const w = a, h = b;
      if (a > 0 && b > 0 && Number.isInteger(a) && Number.isInteger(b)) {
        while (b) [a, b] = [b, a % b];
        const value = `${w / a}:${h / a}`;
        if (![...ratio.options].some(option => option.value === value)) ratio.add(new Option(value, value));
        ratio.value = value;
      }
    }
    syncSize();
    dimensions.addEventListener('input', () => { syncSize(); changed(); });
    const epoch = session().epoch, userId = session().user?.id;
    const admin = session().user?.role === 'admin';
    let config = null, videoConfig = null, error = '', videoError = '', loading = !!userId, loadingVideo = admin;
    let previousVideoControls = false;
    const current = () => form.isConnected && session().epoch === epoch;
    let categoryInitialized = false;
    const categoryOptions = () => {
      const options = new Set(['GPT Image']);
      for (const model of config?.models || []) if (model.category) options.add(model.category);
      return [...options];
    };
    function fillCategories(selected) {
      const options = categoryOptions();
      categorySelect.innerHTML = options.map(option => `<option value="${escape(option)}">${escape(option)}</option>`).join('');
      categorySelect.value = options.includes(selected) ? selected : 'GPT Image';
    }
    // 生成结果归入所选模型分类，默认跟随管理员为该模型配置的分类。
    function syncCategory() {
      const model = config?.models?.find(item => item.id === modelSelect.value);
      fillCategories(categoryInitialized ? model?.category : draft.modelCategory || model?.category);
      categoryInitialized = true;
    }
    function render() {
      if (!current()) return;
      const image = type.value === 'image';
      const videoEnabled = !image && !!videoConfig?.available;
      const busy = running.has(userId);
      dimensions.hidden = !image; ratio.closest('.field').hidden = image;
      countField.hidden = videoEnabled;
      duration.closest('.field').hidden = !videoEnabled;
      negative.hidden = videoEnabled;
      prompt.maxLength = videoEnabled ? 2000 : 8000;
      form.querySelector('#creative-length').textContent = prompt.value.length + ' / ' + prompt.maxLength;
      description.textContent = image ? '描述你的画面，生成图片并保存到私有记录。' : videoEnabled ? '描述你的画面，生成视频并保存到私有记录。' : '保存视频提示词和参考图。';
      if (videoEnabled !== previousVideoControls) {
        ratio.innerHTML = videoEnabled ? videoRatios.map(value => `<option>${value}</option>`).join('') : draftRatios;
        if (image) syncSize();
        previousVideoControls = videoEnabled;
      }
      if (videoEnabled) ratio.value = videoRatio;
      status.classList.toggle('has-error', !!(image ? error : videoError));
      button.disabled = busy || (image ? loading || !!userId && (!config?.available || !modelSelect.value) : loadingVideo || !videoEnabled);
      button.title = '';
      button.textContent = image ? busy ? '正在生成图片…' : userId ? '生成图片' : '登录后生成图片' : busy ? '正在提交视频…' : '生成视频';
      if (!image) {
        status.textContent = videoError || (loadingVideo ? '正在读取视频配置…' : videoEnabled ? busy ? '正在提交视频任务…' : '任务进度可在生成记录查看。' : '视频生成仅向已启用服务的管理员开放。');
        return;
      }
      if (!userId) { status.textContent = '登录后可使用生图服务，生成结果仅当前账号可见。'; return; }
      if (loading) { status.textContent = '正在读取生图配置…'; return; }
      if (error) { status.textContent = error; return; }
      if (busy) { status.textContent = '图片生成中，可关闭窗口；完成后会保存在生成记录。请勿重复提交。'; return; }
      status.textContent = config?.available ? '生图服务已配置。参考图仅用于生成，不会自动投稿。' : '生图服务尚未配置，请联系管理员。';
      if (session().user?.role === 'admin') {
        const settings = document.createElement('button'); settings.type = 'button'; settings.className = 'generation-settings-link'; settings.textContent = '配置生图服务'; settings.addEventListener('click', openSettings); status.appendChild(settings);
      }
    }
    function fillModels() {
      if (type.value === 'video') {
        if (videoConfig?.available) modelSelect.innerHTML = '<option value="muse-video">Muse Video</option>';
        return;
      }
      if (!config) return;
      if (!config.models.length) return;
      modelSelect.innerHTML = config.models.map(model => `<option value="${escape(model.id)}" data-model-id="${escape(model.id)}">${escape(model.name)}</option>`).join('') || '<option value="">暂无可用模型</option>';
      modelSelect.value = config.models.some(model => model.id === draft.modelId) ? draft.modelId : config.defaultModel;
      syncCategory();
    }
    type.addEventListener('change', () => { videoError = ''; fillModels(); syncSize(); render(); });
    modelSelect.addEventListener('change', () => { if (type.value === 'image') syncCategory(); });
    refreshCreator = render;
    render();
    let lastVideoRequest;
    button.addEventListener('click', async () => {
      if (!userId) { login(); return; }
      if (running.has(userId) || !form.reportValidity()) return;
      const data = getCreative();
      if (!data.prompt) { status.textContent = '先写下一段提示词。'; return; }
      const referenceSnapshot = references().slice();
      const video = data.type === 'video';
      if (video && (!videoConfig?.available || data.prompt.length > 2000)) {
        videoError = '视频生成需要已启用的服务，提示词最多 2,000 字符。'; render(); return;
      }
      running.add(userId); error = ''; videoError = ''; render();
      // Capture local Files before closing the creator revokes its preview URLs.
      try {
        const files = await Promise.all(referenceSnapshot.map(async ref => {
          if (ref.file) return ref.file;
          const url = new URL(ref.url, location.origin);
          if (url.origin !== location.origin || !url.pathname.startsWith(appPath) ||
            !/^(assets|media|generation-media)\//.test(url.pathname.slice(appPath.length))) throw new Error('参考图地址不受支持。');
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) throw new Error('参考图无法读取或无权访问，请重新添加。');
          return new File([await response.blob()], ref.name || '参考图', { type: response.headers.get('content-type')?.split(';')[0] || '' });
        }));
        if (session().epoch !== epoch) return;
        const payload = new FormData();
        let metadata = data, requestId = crypto.randomUUID();
        if (video) {
          if (files.reduce((total, file) => total + file.size, 0) > 28 * 1024 ** 2) throw new Error('视频参考图合计不能超过 28 MiB。');
          metadata = { title: data.title, prompt: data.prompt, category: data.category, ratio: data.ratio, duration: data.requestedDuration };
          const fingerprint = JSON.stringify([metadata, referenceSnapshot.map(ref => ref.url)]);
          if (lastVideoRequest?.fingerprint === fingerprint) requestId = lastVideoRequest.requestId;
          else lastVideoRequest = { fingerprint, requestId };
        }
        payload.set('metadata', JSON.stringify({ ...metadata, requestId }));
        for (const file of files) payload.append('files', file);
        const response = await fetch(video ? '/api/video-jobs' : '/api/generations', { method: 'POST', body: payload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '生成失败，请稍后再试。');
        if (session().epoch !== epoch) return;
        const show = form.isConnected && document.querySelector('#creator').open;
        if (video) { lastVideoRequest = null; videoAccepted(result.job, show); }
        else completed(result.generation, show);
      } catch (failure) {
        if (session().epoch === epoch) {
          const message = failure.message || '生成请求中断，请先检查生成记录，避免重复生成。';
          if (video) videoError = message; else error = message;
          if (!current()) toast(message);
        }
      } finally { running.delete(userId); refreshCreator?.(); }
    });
    await Promise.all([
      userId && request('/api/generation/config').then(result => { config = result; if (current() && type.value === 'image') fillModels(); })
        .catch(failure => { error = failure.message; }).finally(() => { loading = false; render(); }),
      admin && request(videoConfigPath).then(result => { videoConfig = result; if (current() && type.value === 'video') fillModels(); })
        .catch(failure => { videoError = failure.message; }).finally(() => { loadingVideo = false; render(); })
    ]);
  }
  return { openSettings, openVideoSettings, attachCreator };
}
