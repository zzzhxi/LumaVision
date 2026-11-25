import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [revision, checksum] = (await readFile(join(root, 'deploy/muse2api-release'), 'utf8')).trim().split(' ');
const engineRoot = join(root, 'upstream/muse2api');
const release = join(engineRoot, 'releases', revision);
const prepared = join(release, '.prepared');
const python = join(release, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const state = join(engineRoot, 'state');
const config = join(state, '.env');

async function setupMuse() {
  if (!existsSync(prepared)) {
    const response = await fetch(`https://codeload.github.com/czg86389-hub/muse2api/tar.gz/${revision}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Muse 源码下载失败（HTTP ${response.status}）`);
    const source = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(source).digest('hex') !== checksum) {
      throw new Error('Muse 源码包 SHA-256 不匹配。');
    }
    await mkdir(release, { recursive: true });
    const archive = join(release, 'source.tar.gz');
    await writeFile(archive, source);
    try {
      execFileSync('tar', ['-xf', archive, '--strip-components=1', '-C', release], { stdio: 'inherit' });
    } finally {
      await unlink(archive);
    }
    execFileSync(process.env.MUSE2API_PYTHON || 'python', ['-m', 'venv', join(release, '.venv')], { stdio: 'inherit' });
    execFileSync(python, ['-m', 'pip', 'install', '--only-binary=:all:', '-r', join(release, 'requirements.txt')], { stdio: 'inherit' });
    await writeFile(prepared, '');
  }
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(config, `MUSE2API_KEY=m2a_${randomBytes(24).toString('hex')}\n`, {
    flag: 'wx', mode: 0o600,
  }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  console.log('Muse 引擎已安装。运行 npm start 启动网站和引擎。');
}

async function museListening(port) {
  const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })
    .then(response => response.json()).catch(() => null);
  if (health?.status !== 'ok') return false;
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(800) })
    .catch(() => null);
  await models?.body?.cancel();
  return models?.status === 401;
}

async function startMuse() {
  const port = Number(process.env.MUSE2API_PORT || 18610);
  if (await museListening(port)) {
    console.log(`Muse 引擎已在运行：127.0.0.1:${port}`);
    return;
  }
  const key = (await readFile(config, 'utf8'))
    .match(/^[ \t]*MUSE2API_KEY[ \t]*=([^\r\n]*)/m)?.[1].trim().replace(/^['"]+|['"]+$/g, '');
  if (!key) {
    throw new Error('请在 upstream/muse2api/state/.env 设置有效的 MUSE2API_KEY。');
  }
  const env = {
    ...process.env,
    MUSE2API_HOME: state,
    MUSE2API_HOST: '127.0.0.1',
    MUSE2API_PORT: String(port),
    MUSE2API_CDP_PORT: process.env.MUSE2API_CDP_PORT || '19210',
    MUSE2API_MANAGED_DEPLOYMENT: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
  delete env.MUSE2API_KEY;

  const log = await open(join(state, 'server.log'), 'a', 0o600);
  let engine;
  try {
    engine = spawn(python, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: release, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
    });
    await once(engine, 'spawn');
    engine.unref();
  } finally {
    await log.close();
  }
  for (let attempt = 0; attempt < 20 && engine.exitCode === null; attempt++) {
    if (await museListening(port)) {
      console.log(`Muse 引擎已启动：127.0.0.1:${port}`);
      return;
    }
    await delay(500);
  }
  throw new Error('Muse 引擎未通过启动检查，请查看 upstream/muse2api/state/server.log。');
}

if (process.argv[2] === '--setup') {
  await setupMuse();
} else {
  if (existsSync(prepared)) await startMuse().catch(error => console.warn(error.message));
  const site = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, stdio: 'inherit' });
  const [code] = await once(site, 'exit');
  process.exitCode = code ?? 1;
}
