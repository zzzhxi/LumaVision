import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { emailDeliveryMode, sendAuthCode } from '../email.mjs';
import { createAuthStore } from '../auth.mjs';
import { HttpError } from '../storage.mjs';

function preserveConfig(t) {
  const keys = ['RESEND_API_KEY', 'AUTH_EMAIL_FROM', 'AUTH_EMAIL_DEMO', 'AUTH_EMAIL_PROVIDER', 'GMAIL_USER', 'GMAIL_APP_PASSWORD'];
  const values = keys.map(key => process.env[key]);
  keys.forEach(key => delete process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (values[index] === undefined) delete process.env[key]; else process.env[key] = values[index]; }));
}

test('邮件发送：明确区分本地演示、未配置和真实发信，真实响应不回传验证码', async t => {
  preserveConfig(t);
  const input = { email: 'member@test.dev', code: '012345', challengeId: 'challenge-1' };
  assert.equal(emailDeliveryMode(), 'demo');
  assert.deepEqual(await sendAuthCode(input), { delivery: 'demo', devCode: '012345' });
  process.env.AUTH_EMAIL_DEMO = 'false';
  await assert.rejects(sendAuthCode(input), { status: 503 });
  process.env.RESEND_API_KEY = 'test-key';
  assert.equal(emailDeliveryMode(), 'unavailable');
  process.env.AUTH_EMAIL_FROM = 'LumaVision <login@test.dev>';
  let outgoing;
  const delivered = await sendAuthCode(input, { fetchImpl: async (url, options) => {
    outgoing = { url, ...options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'email-1' }) };
  } });
  assert.equal(outgoing.url, 'https://api.resend.com/emails');
  assert.equal(outgoing.headers.Authorization, 'Bearer test-key');
  assert.equal(outgoing.headers['Idempotency-Key'], 'auth-challenge-1');
  assert.deepEqual(outgoing.body.to, ['member@test.dev']);
  assert.match(outgoing.body.text, /012345/);
  assert.deepEqual(delivered, { delivery: 'email' });
  await assert.rejects(sendAuthCode(input, { fetchImpl: async () => ({ ok: false, json: async () => ({ message: 'private-provider-error' }) }) }), error => error.status === 502 && !error.message.includes('private-provider-error'));
  await assert.rejects(sendAuthCode(input, { fetchImpl: async () => { throw new Error('network'); } }), { status: 502 });
});

test('发信失败不创建账号、不使旧验证码失效；发送限流在存储中保留', async t => {
  const parent = resolve('test-results');
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'email-test-'));
  t.after(async () => { const target = resolve(dir); assert.ok(target.startsWith(parent + sep) && target.includes('email-test-')); await rm(target, { recursive: true, force: true }); });
  let fail = true, sent;
  const options = { sendCode: async input => { if (fail) throw new HttpError(502, '发送失败'); sent = input.code; return { delivery: 'email' }; }, captchaFactory: () => ({ text: 'ABC234', image: Buffer.from('captcha') }), registrationEmailDomains: null };
  let auth = createAuthStore(dir, options);
  const now = Date.now();
  await assert.rejects(auth.requestCode('member@test.dev', now), { status: 502 });
  assert.equal(await auth.userByEmail('member@test.dev'), null);
  fail = false;
  const challenge = await auth.requestCode('member@test.dev', now);
  const code = sent;
  auth = createAuthStore(dir, options);
  await assert.rejects(auth.requestCode('member@test.dev', now + 100), { status: 429 });
  fail = true;
  await assert.rejects(auth.requestCode('member@test.dev', now + 60001), { status: 502 });
  const captcha = await auth.createCaptcha(now + 60002);
  assert.equal((await auth.register({ email: 'member@test.dev', code, challengeId: challenge.challengeId, password: 'Pass1234', captchaId: captcha.challengeId, captcha: 'ABC234', now: now + 60002 })).email, 'member@test.dev');
});
