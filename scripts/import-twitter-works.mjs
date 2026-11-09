import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, open, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthStore } from '../auth.mjs';
import { inferModel } from './model-inference.mjs';
import { createStore, identify, limits } from '../storage.mjs';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mediaExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm']);
const markerPattern = /(?:^|[ \t\n])(?:正向)?(?:prompt|提示词(?:如下|自取|哦)?)(?:(?:[ \t\uFE0F👇⬇]*[：:；])|(?:[ \t\uFE0F]*[👇⬇]+)|(?=\n|$)|(?=[ \t]*\d+\s*[:：]))[ \t\uFE0F👇⬇]*/i;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function argumentsFrom(argv) {
  const result = { source: '', data: join(projectRoot, 'data'), account: '', nickname: '', defaultModel: 'GPT Image', publish: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--publish') result.publish = true;
    else if (value === '--source') result.source = resolve(argv[++index] || '');
    else if (value === '--data') result.data = resolve(argv[++index] || '');
    else if (value === '--account') result.account = argv[++index] || '';
    else if (value === '--nickname') result.nickname = argv[++index] || '';
    else if (value === '--default-model') result.defaultModel = argv[++index] || '';
    else throw new Error(`不支持的参数：${value}`);
  }
  if (!result.source) throw new Error('请使用 --source 指定 organized 目录。');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(result.account)) throw new Error('请使用 --account 指定有效的 X 账号。');
  if (!result.nickname.trim() || result.nickname.trim().length > 20) throw new Error('请使用 --nickname 指定 1-20 个字符的作者昵称。');
  if (!result.defaultModel.trim() || result.defaultModel.trim().length > 40) throw new Error('默认模型需为 1-40 个字符。');
  result.nickname = result.nickname.trim();
  result.defaultModel = result.defaultModel.trim();
  return result;
}

function deterministicWorkId(account, tweetId) {
  const hex = createHash('sha256').update(`twitter:${account.toLowerCase()}:${tweetId}`).digest('hex').slice(0, 32);
  return `work-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compactTitle(value, tweetId, nickname) {
  const clean = String(value || '')
    .replace(/(?:，|,)?\s*(?:提示词|prompt).{0,16}(?:评论区|下面|下方)[！!。.]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return `${nickname} 的 AI 作品 ${tweetId}`;
  return clean.length <= 70 ? clean : `${clean.slice(0, 69)}…`;
}

function splitContent(content, tweetId, nickname) {
  const clean = String(content || '').replace(/\r/g, '').trim();
  const match = markerPattern.exec(clean);
  if (!match) {
    const firstLine = clean.split('\n')[0];
    const looksLikePrompt = /^(?:\d+\s*:\s*\d+|vertical\b|photorealistic\b|a detailed\b|a soft focus\b|generate\b)/i.test(firstLine);
    return { title: compactTitle(looksLikePrompt ? '' : firstLine, tweetId, nickname), prompt: clean };
  }
  return {
    title: compactTitle(clean.slice(0, match.index), tweetId, nickname),
    prompt: clean.slice(match.index + match[0].length).trim()
  };
}

function inferRatio(prompt) {
  const normalized = prompt.replace(/[×x]/gi, ':');
  for (const ratio of ['9:16', '16:9', '1:1', '3:4', '4:3']) if (normalized.includes(ratio)) return ratio;
  if (/\b2\s*:\s*3\b/.test(normalized)) return '3:4';
  return '3:4';
}

function inferCategory(content, type) {
  if (/(动漫|插画|anime|illustration|毛线)/i.test(content)) return '创意艺术';
  return type === 'video' ? '电影感' : '人像摄影';
}


function parseDate(value) {
  const timestamp = Date.parse(String(value || '').trim().replace(' ', 'T'));
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

async function promptFromReplies(directory) {
  try {
    const parsed = JSON.parse(await readFile(join(directory, 'replies.json'), 'utf8'));
    const replies = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.replies) ? parsed.replies : [];
    return replies
      .map(reply => String(reply?.content || '').trim())
      .find(content => content.length >= 100 && content.length <= 8000 && !content.startsWith('@')) || '';
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function readItems(source, { account, nickname, defaultModel }) {
  const sourcePrefixPattern = new RegExp(`^来源\\s*[：:]\\s*推文\\s+\\d+\\s+by\\s+@${escapeRegex(account)}\\s*`, 'i');
  const entries = (await readdir(source, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d{8}_\d{10,25}$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const items = [];
  for (const entry of entries) {
    const directory = join(source, entry.name);
    let organizedPromptRaw;
    try {
      organizedPromptRaw = await readFile(join(directory, 'prompt.txt'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const tweet = JSON.parse(await readFile(join(directory, 'tweet.json'), 'utf8'));
    const tweetId = /_(\d{10,25})$/.exec(entry.name)?.[1] || '';
    if (!/^\d{10,25}$/.test(tweetId)) throw new Error(`${entry.name} 的推文编号无效。`);
    if (tweet.author?.name !== account && tweet.user?.name !== account) throw new Error(`${entry.name} 的作者不是 ${account}。`);
    const names = (await readdir(directory, { withFileTypes: true }))
      .filter(file => file.isFile() && mediaExtensions.has(file.name.slice(file.name.lastIndexOf('.')).toLowerCase()))
      .map(file => file.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!names.length) throw new Error(`${entry.name} 没有媒体文件。`);
    if (names.length > limits.count) throw new Error(`${entry.name} 超过每件作品 ${limits.count} 个附件的限制。`);
    const media = [];
    let total = 0;
    for (const name of names) {
      const path = join(directory, name), info = await stat(path);
      if (!info.size || info.size > limits.video) throw new Error(`${entry.name}/${name} 为空或超过单文件限制。`);
      const handle = await open(path, 'r');
      const bytes = Buffer.alloc(Math.min(256, info.size));
      try { await handle.read(bytes, 0, bytes.length, 0); } finally { await handle.close(); }
      const format = identify(bytes);
      if (!format) throw new Error(`${entry.name}/${name} 不是站点支持的有效图片或视频。`);
      if (info.size > limits[format.type]) throw new Error(`${entry.name}/${name} 超过${format.type === 'image' ? '图片 20' : '视频 100'} MB 限制。`);
      total += info.size;
      media.push({ name, path, size: info.size, hash: await fileHash(path), mime: format.mime, type: format.type });
    }
    if (total > limits.total) throw new Error(`${entry.name} 的附件总大小超过 200 MB。`);
    const organizedPrompt = organizedPromptRaw.replace(sourcePrefixPattern, '').trim();
    const organized = splitContent(organizedPrompt, tweetId, nickname);
    const mainTweet = splitContent(tweet.content, tweetId, nickname);
    const genericTitle = `${nickname} 的 AI 作品 ${tweetId}`;
    const modelOnlyTitle = /^(?:GPT\s*Image|Nano\s*Banana|Seedream|Hailuo|海螺|Seedance|Grok|豆包|Doubao|Kling|可灵|Veo|Sora|Wan|Midjourney|MJ|FLUX)\s*\d*(?:\.\d+)?$/i.test(organized.title);
    const weakOrganizedTitle = organized.title === genericTitle || modelOnlyTitle || /^(?:全身|半身|俯视|视频)?(?:照)?提示词[：:]?$/i.test(organized.title);
    const title = weakOrganizedTitle && mainTweet.title !== genericTitle ? mainTweet.title : organized.title;
    const needsReply = organizedPrompt.length < 300 && /(?:提示词|prompt).{0,16}(?:评论区|下方|下面)/i.test(organizedPrompt);
    const replyPrompt = needsReply ? await promptFromReplies(directory) : '';
    const prompt = replyPrompt || organized.prompt;
    if (!prompt) throw new Error(`${entry.name} 没有可发布的提示词。`);
    if (prompt.length > 8000) throw new Error(`${entry.name} 的提示词超过 8000 字。`);
    const type = media.some(item => item.type === 'video') ? 'video' : 'image';
    const content = `${tweet.content || ''}\n${organizedPrompt}\n${prompt}`;
    items.push({
      directory,
      tweetId,
      workId: deterministicWorkId(account, tweetId),
      title,
      prompt,
      ratio: inferRatio(prompt),
      category: inferCategory(content, type),
      model: inferModel(`${tweet.model || ''}\n${tweet.metadata?.model || ''}\n${content}`, type, defaultModel),
      type,
      created: parseDate(tweet.date),
      sourceDate: String(tweet.date || ''),
      media,
      total
    });
  }
  return items;
}

async function ensureAuthor(auth, { account, nickname }) {
  const email = `${account.toLowerCase()}@import.lumavision.local`;
  const social = { x: `https://x.com/${account}` };
  let user = await auth.userByEmail(email);
  if (!user) user = await auth.upsertImportedAuthor(account, nickname);
  if (user.onboardingComplete === false) {
    user = await auth.completeOnboarding(user.id, { nickname, accountType: 'creator', social });
  } else {
    user = await auth.updateProfile(user.id, { nickname, social });
    if ((user.creatorStatus || 'none') === 'none' || user.creatorStatus === 'rejected') {
      user = await auth.requestCreator(user.id, { social });
    }
  }
  if (user.creatorStatus === 'pending') user = await auth.reviewCreator(user.id, { decision: 'approve' });
  if (user.creatorStatus !== 'approved') throw new Error(`无法建立已通过的 ${account} 创作者身份。`);
  return user;
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const importActor = (author, item, account) => ({ id: author.id, nickname: author.nickname, importCreated: item.created,
  importSource: { platform: 'x', account, tweetId: item.tweetId, url: `https://x.com/${account}/status/${item.tweetId}`, date: item.sourceDate } });

async function verifyImported(items, dataRoot, store, authorId, account) {
  let media = 0;
  const statuses = {};
  for (const item of items) {
    const work = await store.get(item.workId);
    if (!work || work.authorId !== authorId || work.source?.account !== account || work.source?.tweetId !== item.tweetId) throw new Error(`导入记录核验失败：${item.tweetId}`);
    // An imported work can be edited by its author; a repeat import must preserve that edit.
    statuses[work.status || 'published'] = (statuses[work.status || 'published'] || 0) + 1;
    for (let index = 0; index < work.media.length; index += 1) {
      const storedPath = join(dataRoot, 'media', work.media[index].id);
      if (!(await stat(storedPath)).isFile()) throw new Error(`附件不存在：${item.tweetId}`);
      if (work.media[index].hash && await fileHash(storedPath) !== work.media[index].hash) throw new Error(`附件字节核验失败：${item.tweetId}`);
      media += 1;
    }
  }
  return { works: items.length, media, statuses };
}

async function publish(items, dataRoot, options) {
  await mkdir(dataRoot, { recursive: true });
  const auth = createAuthStore(dataRoot);
  const store = createStore(dataRoot);
  try {
  await Promise.all([auth.ready, store.ready]);
  const author = await ensureAuthor(auth, options);
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const item of items) {
    const existing = await store.get(item.workId);
    if (existing) {
      if (existing.source?.platform !== 'x' || existing.source?.account !== options.account || existing.source?.tweetId !== item.tweetId || existing.authorId !== author.id) {
        throw new Error(`作品编号冲突：${item.workId}`);
      }
      if ((existing.status || 'published') === 'published' && existing.model === '未标注' && item.model === 'GPT Image') {
        await store.save({
          id: existing.id,
          revision: existing.revision,
          requestId: randomUUID(),
          intent: 'submit',
          title: existing.title,
          prompt: existing.prompt,
          model: item.model,
          category: existing.category,
          ratio: existing.ratio,
          type: existing.type,
          media: existing.media.map(media => ({ existing: media.id }))
        }, [], importActor(author, item, options.account));
        updated += 1;
        continue;
      }
      skipped += 1;
      continue;
    }
    const metadata = {
      id: item.workId,
      revision: 0,
      requestId: randomUUID(),
      intent: 'submit',
      title: item.title,
      prompt: item.prompt,
      model: item.model,
      category: item.category,
      ratio: item.ratio,
      type: item.type,
      media: item.media.map((_, index) => ({ file: index }))
    };
    const files = item.media.map(media => ({ name: media.name, size: media.size, type: media.mime, async arrayBuffer() {
      if ((await stat(media.path)).size !== media.size || await fileHash(media.path) !== media.hash) throw new Error(`预检后源文件已改变：${media.name}`);
      return readFile(media.path);
    } }));
    await store.save(metadata, files, importActor(author, item, options.account));
    created += 1;
  }
  const verified = await verifyImported(items, dataRoot, store, author.id, options.account);
  return { authorId: author.id, created, updated, skipped, verified };
  } finally { store.close(); }
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  const items = await readItems(options.source, options);
  const mediaCount = items.reduce((sum, item) => sum + item.media.length, 0);
  const totalBytes = items.reduce((sum, item) => sum + item.total, 0);
  const summary = { account: options.account, works: items.length, media: mediaCount, bytes: totalBytes };
  if (!options.publish) {
    console.log(JSON.stringify({ mode: 'dry-run', ...summary, peakRssBytes: process.resourceUsage().maxRSS * 1024, items: items.map(item => ({ tweetId: item.tweetId, title: item.title, promptLength: item.prompt.length, media: item.media.length, type: item.type, model: item.model, ratio: item.ratio, category: item.category })) }, null, 2));
    return;
  }
  const result = await publish(items, options.data, options);
  console.log(JSON.stringify({ mode: 'publish', ...summary, ...result, peakRssBytes: process.resourceUsage().maxRSS * 1024, data: options.data }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
