import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { sendGmailCode, gmailConfig } from '../gmail.mjs';
import { sendAuthCode, emailDeliveryMode } from '../email.mjs';
import { loadMailConfig } from '../mail-config.mjs';
import { createApp } from '../server.mjs';

const input = { email: 'member@test.dev', code: '012345', challengeId: 'test-challenge' };
const successfulReplies = ['250-smtp.gmail.com\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 35882577\r\n', '334 user\r\n', '334 password\r\n', '235 authenticated\r\n', '250 sender\r\n', '250 recipient\r\n', '354 data\r\n', '250 accepted\r\n'];

function useGmail(t) {
  const keys = ['AUTH_EMAIL_PROVIDER', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'AUTH_EMAIL_DEMO', 'RESEND_API_KEY', 'AUTH_EMAIL_FROM'];
  const saved = keys.map(key => process.env[key]);
  keys.forEach(key => delete process.env[key]);
  Object.assign(process.env, { AUTH_EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'sender@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' });
  t.after(() => keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }));
}

class SmtpFixture extends EventEmitter {
  constructor(replies = successfulReplies, greeting = '220 smtp.gmail.com ready\r\n') {
    super(); this.responses = [...replies]; this.writes = []; this.destroyed = false;
    this.reply(greeting);
  }
  setEncoding(value) { assert.equal(value, 'utf8'); }
  reply(text) {
    if (text === null) { queueMicrotask(() => this.emit('close')); return; }
    if (text === undefined) return;
    for (let offset = 0; offset < text.length; offset += 7) queueMicrotask(() => { if (!this.destroyed) this.emit('data', text.slice(offset, offset + 7)); });
  }
  write(line) { this.writes.push(line); this.reply(this.responses.shift()); return true; }
  end(line) { this.quit = line; this.emit('close'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('Gmail TLS SMTP：分片与多行响应、邮箱认证、中文 MIME 和最终接受后退出', async t => {
  useGmail(t);
  let socket, options;
  const result = await sendAuthCode(input, { connectImpl: config => { options = config; socket = new SmtpFixture(); return socket; } });
  assert.deepEqual(options, { host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com', minVersion: 'TLSv1.2', rejectUnauthorized: true });
  assert.deepEqual(result, { delivery: 'email' });
  assert.equal(socket.writes[0], 'EHLO localhost\r\n');
  assert.equal(socket.writes[1], 'AUTH LOGIN\r\n');
  assert.equal(Buffer.from(socket.writes[2].trim(), 'base64').toString(), 'sender@gmail.com');
  assert.equal(Buffer.from(socket.writes[3].trim(), 'base64').toString(), 'abcdefghijklmnop');
  assert.equal(socket.writes[4], 'MAIL FROM:<sender@gmail.com>\r\n');
  assert.equal(socket.writes[5], 'RCPT TO:<member@test.dev>\r\n');
  const message = socket.writes[7];
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  assert.match(Buffer.from(message.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, ''), 'base64').toString(), /012345/);
  assert.ok(!message.includes('abcdefghijklmnop'));
  assert.equal(socket.quit, 'QUIT\r\n');
  assert.equal(socket.destroyed, true);
});

test('Gmail SMTP：认证失败、收件人拒绝、断连、畸形响应及超时不泄漏服务响应', async t => {
  useGmail(t);
  for (const [index, response] of [[3, '535 private-provider-detail\r\n'], [5, '550 private-provider-detail\r\n'], [7, null]]) {
    const replies = [...successfulReplies]; replies[index] = response;
    let socket;
    await assert.rejects(sendGmailCode(input, { connectImpl: () => (socket = new SmtpFixture(replies)) }), error => error.status === 502 && !error.message.includes('private-provider-detail'));
    assert.equal(socket.destroyed, true);
    if (index === 3) assert.equal(socket.writes.length, 4);
    if (index === 5) assert.equal(socket.writes.length, 6);
  }
  await assert.rejects(sendGmailCode(input, { connectImpl: () => new SmtpFixture([], 'bad reply\r\n') }), { status: 502 });
  await assert.rejects(sendGmailCode(input, { connectImpl: () => new SmtpFixture([], '250-first\r\n220 wrong code\r\n') }), { status: 502 });
  await assert.rejects(sendGmailCode(input, { connectImpl: () => new SmtpFixture([], undefined), timeoutMs: 10 }), { status: 502 });
  await assert.rejects(sendGmailCode(input, { connectImpl: () => { const socket = new SmtpFixture(); socket.write = () => { throw new Error('private-network-error'); }; return socket; } }), error => error.status === 502 && !error.message.includes('private-network-error'));
  await assert.rejects(sendGmailCode({ ...input, email: 'user@test.dev\r\nMAIL FROM:<other@test.dev>' }), { status: 400 });
});

test('Gmail 配置：应用专用密码格式校验，配置缺失不回退演示或 Resend', async t => {
  useGmail(t);
  assert.equal(emailDeliveryMode(), 'email');
  assert.equal(gmailConfig().password, 'abcdefghijklmnop');
  process.env.GMAIL_APP_PASSWORD = '';
  process.env.RESEND_API_KEY = 'resend-key'; process.env.AUTH_EMAIL_FROM = 'login@test.dev';
  assert.equal(emailDeliveryMode(), 'unavailable');
  await assert.rejects(sendAuthCode(input), { status: 503 });
  process.env.GMAIL_APP_PASSWORD = 'ordinary!password';
  assert.equal(gmailConfig(), null);
  process.env.AUTH_EMAIL_PROVIDER = 'invalid';
  assert.equal(emailDeliveryMode(), 'unavailable');
});

test('本地发信配置：环境优先、无效文件不泄漏内容、HTTP 不公开配置与后端模块', async t => {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'gmail-test-'));
  t.after(async () => { const target = resolve(dir); assert.ok(target.startsWith(parent + sep)); await rm(target, { recursive: true, force: true }); });
  const file = join(dir, 'mail.local.json'), env = { GMAIL_APP_PASSWORD: 'override' };
  await loadMailConfig(file, env);
  await writeFile(file, JSON.stringify({ AUTH_EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'sender@gmail.com', GMAIL_APP_PASSWORD: 'local-secret' }));
  await loadMailConfig(file, env);
  assert.equal(env.GMAIL_APP_PASSWORD, 'override'); assert.equal(env.GMAIL_USER, 'sender@gmail.com');
  await writeFile(file, '{"secret":"private-secret"');
  await assert.rejects(loadMailConfig(file, {}), error => !error.message.includes('private-secret'));
  await writeFile(file, '{"UNEXPECTED":"private-secret"}');
  await assert.rejects(loadMailConfig(file, {}), error => !error.message.includes('private-secret'));
  const { server } = await createApp({ storageRoot: dir });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/mail.local.json', '/mail-config.mjs', '/gmail.mjs', '/email.mjs']) assert.equal((await fetch(base + path)).status, 404);
});
