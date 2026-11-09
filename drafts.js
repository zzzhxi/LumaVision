// Draft previews stay separate from generation references and publishing attachments.
const imagePath = value => typeof value === 'string' && /^\/(?:assets\/[\w-]+\.(?:jpg|png|webp|svg)|media\/[\w.-]+\.(?:jpg|jpeg|png|webp|gif))$/i.test(value) ? value : null;
const sourceImage = source => imagePath(source?.media?.find(media => media.type === 'image')?.url) || imagePath(source?.image);

export function draftPreview(draft, sources = []) {
  if ((!draft.custom || draft.uploaded) && sourceImage(draft)) return { url: sourceImage(draft), label: '来源预览', sourceId: draft.id || null };
  const saved = imagePath(draft.previewImage) || imagePath(draft.image);
  if (saved) return { url: saved, label: draft.previewLabel === '参考图预览' ? '参考图预览' : '来源预览', sourceId: draft.sourceId || null };
  const reference = Array.isArray(draft.references) && draft.references.find(ref => imagePath(ref?.url));
  if (reference) return { url: reference.url, label: '参考图预览', sourceId: reference.sourceId || null };
  const candidates = [...new Map(sources.filter(source => source && source.id !== draft.id && (!source.custom || source.uploaded)).map(source => [source.id, source])).values()];
  let source = candidates.find(item => draft.sourceId && item.id === draft.sourceId);
  if (!source && typeof draft.prompt === 'string' && draft.prompt.trim()) {
    const exact = candidates.filter(item => typeof item.prompt === 'string' && item.prompt.trim() === draft.prompt.trim() && sourceImage(item));
    if (exact.length === 1) source = exact[0];
  }
  const url = sourceImage(source);
  return url ? { url, label: '来源预览', sourceId: source.id } : null;
}
