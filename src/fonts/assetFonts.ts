import type { MediaAsset } from '../editor/mediaTypes';
import { assetFontFamily, fontAssetMetadata } from '../../shared/desktop-fonts';

const promises = new Map<string, Promise<void>>();

/** The exact persisted font file is used by both the interactive and headless canvas. */
export function ensureAssetFont(asset: MediaAsset): Promise<void> {
  const metadata = fontAssetMetadata(asset);
  if (!metadata) return Promise.reject(new Error('工程字体资源无效'));
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return Promise.resolve();
  const key = `${asset.id}\0${asset.src}\0${asset.sourceContentHash ?? ''}`;
  const cached = promises.get(key);
  if (cached) return cached;
  const promise = (async () => {
    if (!asset.src.startsWith('/media/uploads/')) throw new Error(`字体「${metadata.fullName}」不是受管理的本地字体资源`);
    const response = await fetch(asset.src, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`无法读取字体「${metadata.fullName}」，请重新导入`);
    const bytes = await response.arrayBuffer();
    if (asset.sourceContentHash && globalThis.crypto?.subtle) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sourceContentHash) throw new Error(`字体「${metadata.fullName}」校验失败，请重新导入`);
    }
    const face = new FontFace(assetFontFamily(asset.id), bytes, {
      weight: metadata.weightRange ? `${metadata.weightRange[0]} ${metadata.weightRange[1]}` : String(metadata.weight),
      style: metadata.style,
      display: 'block',
    });
    await face.load();
    document.fonts.add(face);
  })().catch((reason: unknown) => {
    promises.delete(key);
    throw reason instanceof Error ? reason : new Error(`字体「${metadata.fullName}」加载失败`);
  });
  promises.set(key, promise);
  return promise;
}

export function ensureReferencedAssetFont(assetId: string, assets: readonly MediaAsset[]): Promise<void> {
  const asset = assets.find((entry) => entry.id === assetId);
  if (!asset || !fontAssetMetadata(asset)) return Promise.reject(new Error(`工程缺少字体资源：${assetId}。请重新导入字体。`));
  return ensureAssetFont(asset);
}
