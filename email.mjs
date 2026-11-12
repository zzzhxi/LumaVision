import { HttpError } from './storage.mjs';
import { gmailConfig, sendGmailCode } from './gmail.mjs';

export function emailDeliveryMode({ allowDemo = true } = {}) {
  const provider = process.env.AUTH_EMAIL_PROVIDER;
  if (provider && !['gmail', 'resend'].includes(provider)) return 'unavailable';
  if (provider === 'gmail' || (!provider && (process.env.GMAIL_USER || process.env.GMAIL_APP_PASSWORD))) return gmailConfig() ? 'email' : 'unavailable';
  if (process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM) return 'email';
  if (process.env.RESEND_API_KEY || process.env.AUTH_EMAIL_FROM) return 'unavailable';
  return !allowDemo || process.env.AUTH_EMAIL_DEMO === 'false' ? 'unavailable' : 'demo';
}

// The demo mode is explicit in the response and UI; it never claims that mail was sent.
const CODE_LABELS = {
  register: '注册验证码',
  login: '登录验证码',
  password: '修改密码验证码',
  reset: '重置密码验证码'
};

export async function sendAuthCode({ email, code, challengeId, purpose = 'register' }, { fetchImpl = fetch, connectImpl, timeoutMs, allowDemo } = {}) {
  const mode = emailDeliveryMode({ allowDemo });
  if (mode === 'demo') return { delivery: 'demo', devCode: code };
  if (mode !== 'email') throw new HttpError(503, '邮箱验证码发送尚未配置，请联系网站管理员。');
  const label = CODE_LABELS[purpose] || CODE_LABELS.register;
  if (process.env.AUTH_EMAIL_PROVIDER === 'gmail' || (!process.env.AUTH_EMAIL_PROVIDER && process.env.GMAIL_USER)) {
    return sendGmailCode({ email, code, label }, { connectImpl, timeoutMs });
  }
  try {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `auth-${challengeId}` },
      body: JSON.stringify({
        from: process.env.AUTH_EMAIL_FROM,
        to: [email],
        subject: `LumaVision ${label}`,
        text: `你的 LumaVision ${label}是：${code}\n\n验证码 10 分钟内有效，只能使用一次。请勿将验证码分享给他人。如果不是你发起的请求，请忽略此邮件。`
      }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.id) throw new HttpError(502, '验证码邮件发送失败，请稍后重试或联系网站管理员。');
    return { delivery: 'email' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, '无法连接邮件服务，请稍后重试。');
  }
}
