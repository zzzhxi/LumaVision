import test from 'node:test';
import assert from 'node:assert/strict';
import { draftPreview } from '../drafts.js';

const work = { id: 'work-1', custom: true, uploaded: true, title: '来源作品', prompt: '窗边的晨光', model: 'GPT Image', media: [{ type: 'image', url: '/media/photo.webp' }] };
const draft = { id: 'custom-1', custom: true, uploaded: false, title: '我的草稿', prompt: '窗边的晨光', model: 'GPT Image', references: [] };

test('旧草稿恢复唯一确切来源封面，作品与我的作品重复列表不造成歧义', () => {
  assert.deepEqual(draftPreview(draft, [work, work]), { url: '/media/photo.webp', label: '来源预览', sourceId: 'work-1' });
  assert.deepEqual(draftPreview({ ...draft, model: 'Seedance' }, [work]), { url: '/media/photo.webp', label: '来源预览', sourceId: 'work-1' });
  assert.equal(draftPreview({ ...draft, prompt: '其他提示词' }, [work]), null);
  assert.equal(draftPreview(draft, [work, { ...work, id: 'work-2' }]), null);
});

test('从作品创建与编辑草稿保留封面；来源预览不生成附件或参考图', () => {
  const preview = draftPreview(work);
  const saved = { ...draft, previewImage: preview.url, previewLabel: preview.label, sourceId: preview.sourceId, prompt: '已编辑的提示词' };
  assert.deepEqual(draftPreview(saved), preview);
  assert.deepEqual(saved.references, []);
  assert.equal(saved.media, undefined);
  assert.equal(saved.uploaded, false);
});

test('参考图草稿显示本地图片，纯文字草稿不臆造封面', () => {
  assert.deepEqual(draftPreview({ ...draft, references: [{ url: '/assets/aurora.jpg', sourceId: 'aurora' }] }), { url: '/assets/aurora.jpg', label: '参考图预览', sourceId: 'aurora' });
  assert.equal(draftPreview(draft), null);
});

test('草稿预览拒绝脚本、外站、临时 Blob、路径穿越及视频冒充图片', () => {
  for (const url of ['javascript:alert(1)', 'https://example.com/photo.jpg', 'blob:temporary', '/media/../private.jpg', '/media/movie.webm']) {
    assert.equal(draftPreview({ ...draft, previewImage: url, references: [{ url }] }), null);
  }
});
