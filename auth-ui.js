import { REGISTRATION_EMAIL_DOMAINS, DEFAULT_REGISTRATION_EMAIL_DOMAIN, emailDomain } from './email-domains.js';

// Verification codes, passwords, and onboarding inputs exist only while this dialog is open.
export function createAuthDialog({ dialog, request, emailMode, onVerified, onAuthenticated, onDismiss, platforms, escape, icon }) {
  let step = 'login', busy = false, completed = false, challenge = null, captcha = null, authenticatedUser = null, timer = null, notice = '';
  let draft;
  const resetDraft = () => {
    draft = { email: '', emailPrefix: '', emailDomain: DEFAULT_REGISTRATION_EMAIL_DOMAIN, code: '', password: '', confirm: '', captcha: '', nickname: '', role: 'personal', social: {}, platform: 'instagram', url: '' };
  };
  resetDraft();
  const find = selector => dialog.querySelector(selector);
  const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
  const registrationEmail = () => {
    const prefix = draft.emailPrefix.trim();
    return prefix ? `${prefix}@${draft.emailDomain}` : '';
  };
  const seedRegistrationEmail = () => {
    const email = draft.email.trim();
    const at = email.lastIndexOf('@');
    if (at <= 0) return;
    const domain = emailDomain(email);
    if (!REGISTRATION_EMAIL_DOMAINS.some(item => item.value === domain)) return;
    draft.emailPrefix = email.slice(0, at);
    draft.emailDomain = domain;
  };
  const passwordProblem = value => {
    if (value.length < 8 || value.length > 64) return '密码需为 8-64 个字符。';
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return '密码需同时包含字母和数字。';
    return '';
  };

  function remember() {
    for (const [key, id] of [['email', 'auth-email'], ['code', 'auth-code'], ['password', 'auth-password'], ['confirm', 'auth-confirm'], ['captcha', 'auth-captcha'], ['nickname', 'auth-nickname'], ['platform', 'creator-platform'], ['url', 'creator-url']]) {
      if (find(`#${id}`)) draft[key] = find(`#${id}`).value;
    }
    if (find('#auth-email-prefix') && find('#auth-email-domain')) {
      draft.emailPrefix = find('#auth-email-prefix').value;
      draft.emailDomain = find('#auth-email-domain').value;
      draft.email = registrationEmail();
    }
    const role = find('[name="auth-role"]:checked');
    if (role) draft.role = role.value;
  }
  function showError(message, field) {
    const error = find('#auth-error');
    error.textContent = message;
    error.hidden = false;
    if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  }
  function updateCountdown() {
    const button = find('#auth-resend');
    if (button && challenge) {
      const seconds = Math.max(0, Math.ceil((challenge.retryAt - Date.now()) / 1000));
      button.disabled = busy || seconds > 0;
      button.textContent = seconds ? `${seconds} 秒后重新获取` : '重新获取验证码';
    }
    const refresh = find('#auth-captcha-refresh');
    if (refresh) refresh.disabled = busy || !captcha;
  }
  function setBusy(value, label) {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    dialog.querySelectorAll('button,input,select').forEach(control => { control.disabled = value; });
    if (label) find('.auth-submit').textContent = label;
    updateCountdown();
  }
  function creatorFields() {
    return `<fieldset class="auth-role-group"><legend>你想如何使用 LumaVision？</legend><div class="auth-role-options"><label><input type="radio" name="auth-role" value="personal" ${draft.role === 'personal' ? 'checked' : ''}><span>个人用户<small>发现和收藏灵感</small></span></label><label><input type="radio" name="auth-role" value="creator" ${draft.role === 'creator' ? 'checked' : ''}><span>创作者<small>申请发布作品</small></span></label></div></fieldset>
      <div id="creator-social-wrap" ${draft.role === 'creator' ? '' : 'hidden'}><p class="auth-material-label">社交主页 <span>至少添加一条，供创作者审核</span></p><div class="auth-social-entry"><select id="creator-platform" aria-label="社交平台">${Object.entries(platforms).map(([key, name]) => `<option value="${key}" ${draft.platform === key ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select><input id="creator-url" aria-label="社交主页链接" type="url" maxlength="300" placeholder="https://instagram.com/你的用户名" value="${escape(draft.url)}"><button type="button" id="creator-add">添加</button></div><div id="creator-links" class="auth-social-links">${Object.entries(draft.social).map(([key, url]) => `<span class="auth-social-chip" title="${escape(url)}">${escape(platforms[key])}<button type="button" data-remove-social="${key}" aria-label="移除 ${escape(platforms[key])}">${icon('x')}</button></span>`).join('')}</div><p class="auth-hint">账号注册后即可使用，创作者申请通过后才能发布作品。</p></div>`;
  }
  function emailField() {
    return `<div class="auth-field"><label for="auth-email">邮箱地址</label><input id="auth-email" type="email" maxlength="120" placeholder="you@example.com" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" value="${escape(draft.email)}" aria-describedby="auth-error" required></div>`;
  }
  function registrationEmailField() {
    const options = REGISTRATION_EMAIL_DOMAINS.map(({ value }) => `<option value="${escape(value)}" ${draft.emailDomain === value ? 'selected' : ''}>@${escape(value)}</option>`).join('');
    return `<div class="auth-field"><label for="auth-email-prefix">邮箱前缀</label><div class="auth-email-compose"><input id="auth-email-prefix" type="text" maxlength="64" placeholder="邮箱前缀" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" value="${escape(draft.emailPrefix)}" aria-describedby="auth-error" required><span class="auth-email-at" aria-hidden="true">@</span><select id="auth-email-domain" aria-label="邮箱后缀">${options}</select></div><p class="auth-hint">仅支持 163、QQ、Gmail、Outlook、126、Hotmail 常见个人邮箱。</p></div>`;
  }
  function passwordField(id, label, autocomplete, hint = '') {
    return `<div class="auth-field"><label for="${id}">${label}</label><input id="${id}" type="password" maxlength="64" autocomplete="${autocomplete}" placeholder="至少 8 位，包含字母和数字" value="${escape(id === 'auth-password' ? draft.password : draft.confirm)}" aria-describedby="auth-error" required>${hint ? `<p class="auth-hint">${hint}</p>` : ''}</div>`;
  }
  function codeField() {
    return `<div class="auth-field"><label for="auth-code">邮箱验证码</label><input id="auth-code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" placeholder="输入 6 位数字" value="${escape(draft.code)}" aria-describedby="auth-error" required></div><button type="button" id="auth-resend" class="auth-resend">重新获取验证码</button>`;
  }
  function captchaFields() {
    return `<div class="auth-field"><label for="auth-captcha">图形验证码</label><div class="auth-captcha-row"><div class="auth-captcha-media"><img id="auth-captcha-image" class="auth-captcha-image" src="${captcha ? escape(captcha.image) : ''}" alt="图形验证码" ${captcha ? '' : 'hidden'}><span id="auth-captcha-loading" class="auth-captcha-loading" ${captcha ? 'hidden' : ''}>正在加载…</span></div><button type="button" id="auth-captcha-refresh" class="auth-captcha-refresh" ${captcha ? '' : 'disabled'}>换一张</button></div><input id="auth-captcha" type="text" inputmode="text" maxlength="6" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="输入图片中的 6 位字符" value="${escape(draft.captcha)}" aria-describedby="auth-error" required></div>`;
  }
  function demoCode() {
    return challenge?.delivery === 'demo' ? `<p class="auth-demo">本地演示，未发送邮件。验证码：<strong>${escape(challenge.devCode)}</strong></p>` : '<p class="auth-hint">验证码已发送，10 分钟内有效。未收到时请检查垃圾邮件。</p>';
  }
  function fieldsForStep() {
    if (step === 'login') {
      return `${emailField()}<div class="auth-field"><div class="auth-field-head"><label for="auth-password">密码</label><button type="button" class="auth-link" data-auth-step="reset">忘记密码？</button></div><input id="auth-password" type="password" maxlength="64" autocomplete="current-password" placeholder="输入登录密码" value="${escape(draft.password)}" aria-describedby="auth-error" required></div><p class="auth-switch">还没有账号？<button type="button" class="auth-link" data-auth-step="register">注册</button></p><p class="auth-hint">旧账号首次登录，请先使用“忘记密码”设置密码。</p>`;
    }
    if (step === 'register') {
      return `${registrationEmailField()}<p class="auth-hint">验证码会发送到该邮箱，用于确认你是账号所有者。</p><p class="auth-switch">已有账号？<button type="button" class="auth-link" data-auth-step="login">返回登录</button></p>`;
    }
    if (step === 'register-verify') {
      return `<div class="auth-email-summary"><span>${escape(challenge.email)}</span><button type="button" class="auth-link" data-auth-step="register">更换邮箱</button></div>${codeField()}${demoCode()}${passwordField('auth-password', '登录密码', 'new-password', '8-64 个字符，需同时包含字母和数字。')}${passwordField('auth-confirm', '确认密码', 'new-password')}${captchaFields()}`;
    }
    if (step === 'reset') {
      return `${emailField()}<p class="auth-hint">我们会向注册邮箱发送验证码，验证后即可设置新密码。</p><p class="auth-switch">想起密码了？<button type="button" class="auth-link" data-auth-step="login">返回登录</button></p>`;
    }
    if (step === 'reset-verify') {
      return `<div class="auth-email-summary"><span>${escape(challenge.email)}</span><button type="button" class="auth-link" data-auth-step="reset">更换邮箱</button></div>${codeField()}${demoCode()}${passwordField('auth-password', '新密码', 'new-password', '8-64 个字符，需同时包含字母和数字。')}${passwordField('auth-confirm', '确认新密码', 'new-password')}`;
    }
    return `<p class="auth-verified-email">${icon('check')}已验证 ${escape(authenticatedUser.email)}</p><div class="auth-field"><label for="auth-nickname">昵称 <span>选填</span></label><input id="auth-nickname" maxlength="20" autocomplete="nickname" placeholder="你希望大家如何称呼你" value="${escape(draft.nickname)}"></div>${creatorFields()}`;
  }

  function render() {
    clearInterval(timer);
    const meta = {
      login: ['欢迎回来', '使用邮箱和密码登录，继续你的灵感收藏。', '登录'],
      register: ['创建账号', '输入邮箱获取验证码，然后设置登录密码。', '获取验证码'],
      'register-verify': ['验证邮箱并设置密码', '输入验证码、设置密码，并填写图形验证码。', '注册'],
      reset: ['重置密码', '输入注册邮箱，我们会发送验证码帮你设置新密码。', '获取验证码'],
      'reset-verify': ['设置新密码', '输入邮箱验证码，然后设置新的登录密码。', '重置密码'],
      setup: ['选择你的账号身份', '邮箱已验证，完成设置即可开始使用。', '完成设置']
    }[step];
    const backStep = step === 'register' || step === 'reset' ? 'login' : step === 'register-verify' ? 'register' : step === 'reset-verify' ? 'reset' : null;
    dialog.dataset.authStep = step;
    dialog.innerHTML = `<div class="auth-layout"><div class="auth-topline">${backStep ? `<button type="button" class="auth-back" data-auth-step="${backStep}">← 返回</button>` : '<span class="auth-wordmark">LumaVision<span>.</span></span>'}<button type="button" class="auth-close" aria-label="关闭登录窗口">${icon('x')}</button></div><header class="auth-welcome"><svg class="auth-brand-mark" viewBox="0 0 40 40" aria-hidden="true"><ellipse cx="20" cy="20" rx="9" ry="16" transform="rotate(-35 20 20)"/><ellipse cx="20" cy="20" rx="9" ry="16" transform="rotate(35 20 20)"/></svg><h2 id="auth-title">${meta[0]}</h2><p id="auth-description">${meta[1]}</p></header>
      <form id="auth-form" novalidate><fieldset class="auth-controls">${notice ? `<p class="auth-notice">${escape(notice)}</p>` : ''}${fieldsForStep()}<p id="auth-error" class="auth-error" role="alert" hidden></p><button type="submit" class="auth-submit">${meta[2]}</button></fieldset></form>
      ${step === 'login' ? `${emailMode() === 'demo' ? '<p class="auth-demo">本地演示模式：验证码显示在页面上，不会发送邮件。</p>' : emailMode() === 'unavailable' ? '<p class="auth-demo">邮箱发送尚未配置，请联系网站管理员。</p>' : ''}` : ''}</div>`;
    find('#auth-form').addEventListener('submit', submit);
    dialog.querySelectorAll('input').forEach(input => input.addEventListener('input', () => input.removeAttribute('aria-invalid')));
    if (step === 'register-verify' || step === 'reset-verify') { updateCountdown(); timer = setInterval(updateCountdown, 1000); }
    const focusTarget = step === 'login' ? (draft.email ? '#auth-password' : '#auth-email') : step === 'setup' ? '#auth-nickname' : step === 'register' ? '#auth-email-prefix' : step === 'reset' ? '#auth-email' : '#auth-code';
    find(focusTarget).focus();
  }

  async function loadCaptcha() {
    const image = find('#auth-captcha-image');
    const loading = find('#auth-captcha-loading');
    if (loading) { loading.textContent = '正在加载…'; loading.hidden = false; }
    if (image) image.hidden = true;
    captcha = null;
    updateCountdown();
    try {
      const data = await request('/api/auth/captcha');
      if (step !== 'register-verify') return;
      captcha = data;
      const nextImage = find('#auth-captcha-image'), nextLoading = find('#auth-captcha-loading');
      if (nextImage) { nextImage.src = data.image; nextImage.hidden = false; }
      if (nextLoading) nextLoading.hidden = true;
      updateCountdown();
    } catch (error) {
      if (step !== 'register-verify') return;
      if (loading) { loading.textContent = '加载失败，请换一张'; loading.hidden = false; }
      const refresh = find('#auth-captcha-refresh');
      if (refresh) refresh.disabled = busy;
      showError(error.message || '图形验证码加载失败，请点击“换一张”重试。');
    }
  }

  async function sendCode(purpose) {
    const email = (step === 'register-verify' || step === 'reset-verify') && challenge?.email ? challenge.email : draft.email.trim();
    setBusy(true, '正在发送验证码…');
    let data;
    try {
      data = await request(purpose === 'reset' ? '/api/auth/password/reset/code' : '/api/auth/code', { method: 'POST', body: { email } });
    } catch (error) {
      showError(error.message, find('#auth-email-prefix') || find('#auth-email'));
    }
    setBusy(false, '获取验证码');
    if (!data) return;
    challenge = { ...data, email };
    draft.code = '';
    draft.captcha = '';
    captcha = null;
    step = purpose === 'reset' ? 'reset-verify' : 'register-verify';
    render();
    if (step === 'register-verify') await loadCaptcha();
  }

  function finish(user, newAccount) {
    completed = true;
    dialog.close();
    onAuthenticated(user, newAccount);
  }
  function completeAuth(user, newAccount) {
    authenticatedUser = user;
    onVerified(user);
    if (!user.onboardingComplete) {
      draft.nickname = user.nickname;
      step = 'setup';
      render();
      return;
    }
    finish(user, newAccount);
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    remember();
    find('#auth-error').hidden = true;
    if (step === 'login') {
      if (!emailPattern.test(draft.email.trim())) { showError('请输入有效的邮箱地址。', find('#auth-email')); return; }
      if (!draft.password) { showError('请输入登录密码。', find('#auth-password')); return; }
      setBusy(true, '正在登录…');
      let data;
      try { data = await request('/api/auth/login', { method: 'POST', body: { email: draft.email.trim(), password: draft.password } }); }
      catch (error) { setBusy(false, '登录'); showError(error.message, find('#auth-password')); return; }
      setBusy(false, '登录');
      draft.password = '';
      completeAuth(data.user, false);
      return;
    }
    if (step === 'register') {
      const prefix = draft.emailPrefix.trim();
      if (!/^[^\s@]{1,64}$/.test(prefix)) { showError('请输入有效的邮箱前缀。', find('#auth-email-prefix')); return; }
      if (!REGISTRATION_EMAIL_DOMAINS.some(item => item.value === draft.emailDomain)) { showError('请选择支持的邮箱后缀。', find('#auth-email-domain')); return; }
      draft.emailPrefix = prefix;
      draft.email = registrationEmail();
      if (!emailPattern.test(draft.email)) { showError('请输入有效的邮箱地址。', find('#auth-email-prefix')); return; }
      await sendCode('register');
      return;
    }
    if (step === 'reset') {
      if (!emailPattern.test(draft.email.trim())) { showError('请输入有效的邮箱地址。', find('#auth-email')); return; }
      await sendCode('reset');
      return;
    }
    if (step === 'register-verify') {
      if (!/^\d{6}$/.test(draft.code.trim())) { showError('请输入 6 位数字验证码。', find('#auth-code')); return; }
      const problem = passwordProblem(draft.password);
      if (problem) { showError(problem, find('#auth-password')); return; }
      if (draft.password !== draft.confirm) { showError('两次输入的密码不一致。', find('#auth-confirm')); return; }
      if (!captcha) { showError('图形验证码正在加载，请稍候。', find('#auth-captcha')); return; }
      if (!/^[A-Za-z0-9]{6}$/.test(draft.captcha.trim())) { showError('请输入图片中的 6 位字符。', find('#auth-captcha')); return; }
      setBusy(true, '正在注册…');
      let data;
      try {
        data = await request('/api/auth/register', { method: 'POST', body: { email: challenge.email, code: draft.code.trim(), challengeId: challenge.challengeId, password: draft.password, captchaId: captcha.challengeId, captcha: draft.captcha.trim() } });
      } catch (error) {
        setBusy(false, '注册');
        showError(error.message, error.message.includes('注册仅支持') ? find('[data-auth-step="register"]') : find('#auth-captcha'));
        draft.captcha = '';
        if (find('#auth-captcha')) find('#auth-captcha').value = '';
        await loadCaptcha();
        return;
      }
      setBusy(false, '注册');
      challenge = null;
      captcha = null;
      draft.code = draft.password = draft.confirm = draft.captcha = '';
      completeAuth(data.user, true);
      return;
    }
    if (step === 'reset-verify') {
      if (!/^\d{6}$/.test(draft.code.trim())) { showError('请输入 6 位数字验证码。', find('#auth-code')); return; }
      const problem = passwordProblem(draft.password);
      if (problem) { showError(problem, find('#auth-password')); return; }
      if (draft.password !== draft.confirm) { showError('两次输入的密码不一致。', find('#auth-confirm')); return; }
      setBusy(true, '正在重置密码…');
      try {
        await request('/api/auth/password/reset', { method: 'POST', body: { email: challenge.email, code: draft.code.trim(), challengeId: challenge.challengeId, password: draft.password } });
      } catch (error) {
        setBusy(false, '重置密码');
        showError(error.message, find('#auth-code'));
        return;
      }
      setBusy(false, '重置密码');
      draft.code = draft.password = draft.confirm = '';
      challenge = null;
      notice = '密码已重置，请使用新密码登录。';
      step = 'login';
      render();
      return;
    }
    if (draft.role === 'creator' && !Object.keys(draft.social).length) { showError('请至少添加一条社交主页链接，供创作者审核。', find('#creator-url')); return; }
    setBusy(true, '正在保存设置…');
    let data;
    try {
      data = await request('/api/user/onboarding', { method: 'PATCH', body: { nickname: draft.nickname.trim(), accountType: draft.role, social: draft.role === 'creator' ? draft.social : {} } });
    } catch (error) {
      setBusy(false, '完成设置');
      showError(error.message);
      return;
    }
    setBusy(false, '完成设置');
    onVerified(data.user);
    finish(data.user, true);
  }

  dialog.addEventListener('click', event => {
    event.stopPropagation();
    if (busy) return;
    const button = event.target.closest('button');
    if (button?.matches('.auth-close')) { dialog.close(); return; }
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
      return;
    }
    if (button?.dataset.authStep) {
      remember();
      draft.password = draft.confirm = draft.code = draft.captcha = '';
      challenge = null;
      captcha = null;
      notice = '';
      const next = button.dataset.authStep;
      if (next === 'register') seedRegistrationEmail();
      step = next;
      render();
      return;
    }
    if (button?.matches('#auth-resend')) { remember(); sendCode(step === 'reset-verify' ? 'reset' : 'register'); return; }
    if (button?.matches('#auth-captcha-refresh')) {
      remember();
      find('#auth-error').hidden = true;
      draft.captcha = '';
      if (find('#auth-captcha')) find('#auth-captcha').value = '';
      loadCaptcha();
      return;
    }
    if (button?.matches('#creator-add')) {
      remember();
      let url;
      try { url = new URL(draft.url.trim()); } catch { showError('请填写完整的社交主页网址。', find('#creator-url')); return; }
      if (url.protocol !== 'https:') { showError('社交主页需以 https:// 开头。', find('#creator-url')); return; }
      draft.social[draft.platform] = url.toString();
      draft.url = '';
      render();
      find('#creator-url').focus();
    }
    if (button?.dataset.removeSocial) { remember(); delete draft.social[button.dataset.removeSocial]; render(); }
  });
  dialog.addEventListener('change', event => {
    if (event.target.name === 'auth-role') { draft.role = event.target.value; find('#creator-social-wrap').hidden = draft.role !== 'creator'; }
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    clearInterval(timer);
    resetDraft();
    challenge = null;
    captcha = null;
    authenticatedUser = null;
    notice = '';
    dialog.replaceChildren();
    if (!completed) onDismiss();
  });
  function open(user = null) {
    if (busy || dialog.open) return;
    resetDraft();
    completed = false;
    challenge = null;
    captcha = null;
    notice = '';
    authenticatedUser = user;
    if (user) {
      draft.email = user.email || '';
      draft.nickname = user.nickname || '';
      step = 'setup';
    } else {
      step = 'login';
    }
    render();
    dialog.showModal();
    find(step === 'setup' ? '#auth-nickname' : draft.email ? '#auth-password' : '#auth-email').focus();
  }
  return { get busy() { return busy; }, open: () => open(), openSetup: user => open(user) };
}
