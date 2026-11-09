import { connect } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { HttpError } from './storage.mjs';

const mailboxRule = /^[^\s@<>]{1,64}@[^\s@<>]{1,253}\.[^\s@<>]{2,}$/;
const validMailbox = value => typeof value === 'string' && value.length <= 120 && mailboxRule.test(value) && !/[^\x21-\x7e]/.test(value);

export function gmailConfig(env = process.env) {
  const user = env.GMAIL_USER?.trim();
  const password = env.GMAIL_APP_PASSWORD?.replace(/\s/g, '');
  return validMailbox(user) && /^[a-z0-9]{16}$/i.test(password || '') ? { user, password } : null;
}

// Fixed TLS destination and default certificate verification; never log SMTP replies or AUTH.
export async function sendGmailCode({ email, code, label = '登录验证码' }, { connectImpl = connect, timeoutMs = 15000 } = {}) {
  const config = gmailConfig();
  if (!config) throw new HttpError(503, 'Gmail 发信尚未配置应用专用密码，请联系网站管理员。');
  if (!validMailbox(email) || !/^\d{6}$/.test(code)) throw new HttpError(400, '邮箱或验证码格式不正确。');
  let socket, timer, waiting, failure, buffer = '', multilineCode = null;
  const replies = [];
  const fail = error => {
    if (failure) return;
    failure = error;
    if (waiting) { waiting.reject(error); waiting = null; }
  };
  const nextReply = () => {
    if (failure) return Promise.reject(failure);
    if (replies.length) return Promise.resolve(replies.shift());
    return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
  };
  async function expect(expected, line) {
    const response = nextReply();
    if (line !== undefined) {
      try { socket.write(line + '\r\n'); }
      catch { fail(new HttpError(502, 'Gmail 邮件连接中断，请稍后重试。')); }
    }
    const status = await response;
    if (!expected.includes(status)) {
      throw new HttpError(502, status === 534 || status === 535 ? 'Gmail 验证失败，请检查应用专用密码。' : 'Gmail 未接受邮件，请稍后重试。');
    }
  }
  try {
    socket = connectImpl({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com', minVersion: 'TLSv1.2', rejectUnauthorized: true });
    socket.setEncoding('utf8');
    socket.on('error', () => fail(new HttpError(502, '无法连接 Gmail 邮件服务，请稍后重试。')));
    socket.on('close', () => fail(new HttpError(502, 'Gmail 邮件连接中断，请稍后重试。')));
    socket.on('data', chunk => {
      if (failure) return;
      buffer += chunk;
      if (buffer.length > 65536) { fail(new HttpError(502, 'Gmail 邮件响应异常。')); socket.destroy(); return; }
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const match = /^(\d{3})([ -])/.exec(line);
        if (!match || (multilineCode && multilineCode !== match[1])) { fail(new HttpError(502, 'Gmail 邮件响应异常。')); socket.destroy(); return; }
        if (match[2] === '-') { multilineCode = match[1]; continue; }
        multilineCode = null;
        const status = Number(match[1]);
        if (waiting) { waiting.resolve(status); waiting = null; } else replies.push(status);
      }
    });
    timer = setTimeout(() => { fail(new HttpError(502, 'Gmail 邮件发送超时，请稍后重试。')); socket.destroy(); }, timeoutMs);
    await expect([220]);
    await expect([250], 'EHLO localhost');
    await expect([334], 'AUTH LOGIN');
    await expect([334], Buffer.from(config.user).toString('base64'));
    await expect([235], Buffer.from(config.password).toString('base64'));
    await expect([250], `MAIL FROM:<${config.user}>`);
    await expect([250, 251], `RCPT TO:<${email}>`);
    await expect([354], 'DATA');
    const text = `你的 LumaVision ${label}是：${code}\n\n验证码 10 分钟内有效，只能使用一次。请勿分享给他人。如果不是你发起的请求，请忽略此邮件。`;
    const encoded = Buffer.from(text).toString('base64').match(/.{1,76}/g).join('\r\n');
    const message = [
      `From: LumaVision <${config.user}>`, `To: <${email}>`,
      `Subject: =?UTF-8?B?${Buffer.from(`LumaVision ${label}`).toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@lumavision.local>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', encoded, '.'
    ].join('\r\n');
    await expect([250], message);
    // Acceptance after DATA establishes success; a QUIT disconnect must not trigger a resend.
    socket.end('QUIT\r\n');
    return { delivery: 'email' };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'Gmail 邮件发送失败，请稍后重试。');
  } finally { clearTimeout(timer); socket?.destroy(); }
}
