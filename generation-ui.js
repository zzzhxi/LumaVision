export function createGenerationUI({ request, session, escape, toast, completed, login }) {
  const dialog = document.querySelector('#generation-settings');
  const running = new Set();
  let refreshCreator;
  dialog.addEventListener('close', () => { dialog.innerHTML = ''; });
  async function openSettings() {
    if (session().user?.role !== 'admin') return;
    const epoch = session().epoch;
    let settings;
    try { settings = await request('/api/admin/generation-config'); }
    catch (error) { toast(error.message); return; }
    if (session().epoch !== epoch) return;
    dialog.innerHTML = `<form class="mini-form generation-form"><button type="button" class="icon-button close" data-close="generation-settings" aria-label="关闭生图服务设置">×</button><p class="eyebrow">IMAGE SERVICE</p><h2 id="generation-settings-title">生图服务</h2><p class="generation-help">由管理员统一配置，登录用户共用。模型列表可能包含不能生图的模型，请只启用已确认的图片模型。</p><label class="field">API Base URL<input name="baseUrl" type="url" required value="${escape(settings.baseUrl)}" placeholder="http://127.0.0.1:38650/v1"></label><label class="field">API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="${settings.hasApiKey ? '已配置；留空保留原密钥' : '输入 Key 或 Bearer Key'}"></label><label class="generation-check"><input name="clearKey" type="checkbox">清除已保存的密钥</label><button type="button" class="button soft" id="generation-test">测试连接并读取模型</button><div class="field"><span>已启用的模型</span><div id="generation-models" class="generation-models"></div></div><div class="generation-manual"><label class="field">手动添加模型 ID<input id="generation-model-id" maxlength="200" placeholder="精确的接口模型 ID"></label><button type="button" class="button soft" id="generation-add-model">添加</button></div><label class="field">默认模型<select name="defaultModel"></select></label><p id="generation-settings-status" role="status" aria-live="polite"></p><div class="mini-form-actions"><button type="button" class="button soft" data-close="generation-settings">取消</button><button type="submit" class="button dark">保存配置</button></div></form>`;
    const form = dialog.querySelector('form'), status = form.querySelector('[role="status"]');
    const models = new Map(settings.models.map(model => [model.id, model]));
    const enabled = new Set(settings.models.map(model => model.id));
    let preferred = settings.defaultModel;
    const isCurrent = () => form.isConnected && session().epoch === epoch;
    function renderModels() {
      form.querySelector('#generation-models').innerHTML = [...models.values()].map(model => `<label class="generation-check"><input type="checkbox" value="${escape(model.id)}" ${enabled.has(model.id) ? 'checked' : ''}><span>${escape(model.id)}</span></label>`).join('') || '<span class="generation-help">读取列表或手动添加一个模型。</span>';
      const select = form.elements.defaultModel;
      const selected = [...models.values()].filter(model => enabled.has(model.id));
      if (!enabled.has(preferred)) preferred = selected[0]?.id || '';
      select.innerHTML = selected.map(model => `<option value="${escape(model.id)}">${escape(model.id)}</option>`).join('') || '<option value="">暂无启用模型</option>';
      select.value = preferred;
    }
    function candidate() { return { baseUrl: form.elements.baseUrl.value.trim(), apiKey: form.elements.apiKey.value, clearKey: form.elements.clearKey.checked }; }
    renderModels();
    form.querySelector('#generation-models').addEventListener('change', event => {
      if (event.target.checked) enabled.add(event.target.value); else enabled.delete(event.target.value);
      preferred = form.elements.defaultModel.value; renderModels();
    });
    form.elements.defaultModel.addEventListener('change', () => { preferred = form.elements.defaultModel.value; });
    form.querySelector('#generation-add-model').addEventListener('click', () => {
      const input = form.querySelector('#generation-model-id'), id = input.value.trim();
      if (!id) { input.focus(); return; }
      models.set(id, { id, name: id.slice(0, 40) }); enabled.add(id); input.value = ''; renderModels();
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
  async function attachCreator({ draft, getCreative, references, changed }) {
    const form = document.querySelector('#creative-form');
    const modelSelect = form.querySelector('#creative-model'), ratio = form.querySelector('#creative-ratio');
    const button = form.querySelector('#generate-button'), status = form.querySelector('.generation-status');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const legacySizes = { '3:4': [768, 1024], '4:3': [1024, 768], '16:9': [1536, 864], '9:16': [864, 1536] };
    const savedSize = [draft.width, draft.height];
    const [width, height] = savedSize.every(value => Number.isInteger(value) && value >= 1 && value <= 9999) ? savedSize : Object.hasOwn(legacySizes, draft.ratio) ? legacySizes[draft.ratio] : [1024, 1024];
    ratio.closest('.field').insertAdjacentHTML('afterend', `<div class="generation-dimensions"><label class="field">图片尺寸<select id="creative-size"><option value="1024x1024">正方形 · 1024 × 1024</option><option value="1024x1536">竖图 · 1024 × 1536</option><option value="1536x1024">横图 · 1536 × 1024</option><option value="custom">自定义尺寸</option></select></label><div class="generation-custom-size"><label class="field">宽度（像素）<input id="creative-width" type="number" min="1" max="9999" step="1" value="${width}"></label><label class="field">高度（像素）<input id="creative-height" type="number" min="1" max="9999" step="1" value="${height}"></label></div><p class="generation-help">可用尺寸和数量以所选模型为准。</p></div>`);
    const size = form.querySelector('#creative-size'), dimensions = form.querySelector('.generation-dimensions');
    size.value = ['1024x1024', '1024x1536', '1536x1024'].includes(`${width}x${height}`) ? `${width}x${height}` : 'custom';
    function syncSize() {
      const custom = size.value === 'custom';
      const image = form.querySelector('#creative-type').value === 'image';
      form.querySelector('.generation-custom-size').hidden = !custom;
      for (const input of dimensions.querySelectorAll('input')) { input.required = custom && image; input.disabled = !custom || !image; }
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
    let config = null, error = '', loading = !!userId;
    const current = () => form.isConnected && session().epoch === epoch;
    function render() {
      if (!current()) return;
      const image = form.querySelector('#creative-type').value === 'image';
      const busy = running.has(userId);
      dimensions.hidden = !image; ratio.closest('.field').hidden = image;
      button.disabled = !image || loading || busy || !!userId && (!config?.available || !modelSelect.value);
      button.title = '';
      button.textContent = !image ? '生成视频（暂未接入）' : busy ? '正在生成图片…' : userId ? '生成图片' : '登录后生成图片';
      if (!image) { status.textContent = '视频生成暂未接入，可继续保存视频提示词草稿。'; return; }
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
      if (form.querySelector('#creative-type').value !== 'image' || !config) return;
      if (!config.models.length) return;
      modelSelect.innerHTML = config.models.map(model => `<option value="${escape(model.id)}" data-model-id="${escape(model.id)}">${escape(model.name)}</option>`).join('') || '<option value="">暂无可用模型</option>';
      modelSelect.value = config.models.some(model => model.id === draft.modelId) ? draft.modelId : config.defaultModel;
    }
    form.querySelector('#creative-type').addEventListener('change', () => { fillModels(); syncSize(); render(); });
    refreshCreator = render;
    render();
    button.addEventListener('click', async () => {
      if (!userId) { login(); return; }
      if (running.has(userId) || !form.reportValidity()) return;
      const data = getCreative();
      if (!data.prompt) { status.textContent = '先写下一段提示词。'; return; }
      const referenceSnapshot = references().slice();
      running.add(userId); error = ''; render();
      // Capture local Files before closing the creator revokes its preview URLs.
      try {
        const files = await Promise.all(referenceSnapshot.map(async ref => {
          if (ref.file) return ref.file;
          const url = new URL(ref.url, location.origin);
          if (url.origin !== location.origin || !/^\/(assets|media|generation-media)\//.test(url.pathname)) throw new Error('参考图地址不受支持。');
          const response = await fetch(url, { cache: 'no-store' });
          if (!response.ok) throw new Error('参考图无法读取或无权访问，请重新添加。');
          return new File([await response.blob()], ref.name || '参考图', { type: response.headers.get('content-type')?.split(';')[0] || '' });
        }));
        if (session().epoch !== epoch) return;
        const payload = new FormData();
        payload.set('metadata', JSON.stringify({ ...data, requestId: crypto.randomUUID() }));
        for (const file of files) payload.append('files', file);
        const response = await fetch('/api/generations', { method: 'POST', body: payload });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '生成失败，请稍后再试。');
        if (session().epoch !== epoch) return;
        completed(result.generation, form.isConnected && document.querySelector('#creator').open);
      } catch (failure) {
        if (session().epoch === epoch) {
          error = failure.message || '生成请求中断，请先检查生成记录，避免重复生成。';
          if (!current()) toast(error);
        }
      } finally { running.delete(userId); refreshCreator?.(); }
    });
    if (userId) {
      try { config = await request('/api/generation/config'); if (current()) fillModels(); }
      catch (failure) { error = failure.message; }
      finally { loading = false; render(); }
    }
  }
  return { openSettings, attachCreator };
}
