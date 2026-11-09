import { readFile } from 'node:fs/promises';

const configKeys = ['AUTH_EMAIL_PROVIDER', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'AUTH_EMAIL_DEMO'];

// Only the direct server entrypoint loads local settings; isolated tests keep their own config.
export async function loadMailConfig(file, env = process.env) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法读取 mail.local.json，请检查文件权限。'); }
  let config;
  try { config = JSON.parse(raw); }
  catch { throw new Error('mail.local.json 格式错误，请检查 JSON。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.entries(config).some(([key, value]) => !configKeys.includes(key) || typeof value !== 'string')) {
    throw new Error('mail.local.json 只接受指定的邮件配置字符串字段。');
  }
  for (const [key, value] of Object.entries(config)) if (env[key] === undefined) env[key] = value;
}
