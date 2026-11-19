import type { FontPickerEntry } from './fontPickerModel';
import { ensureFont } from './googleFonts';
import { ensureAssetFont } from './assetFonts';
import { assetFontFamily } from '../../shared/desktop-fonts';

interface Preview { family: string; face?: FontFace }
const samples = new Map<string, Promise<Preview>>();
const loaded = new Map<string, Preview>();
let queue: Promise<unknown> = Promise.resolve();

/** Metadata enumeration creates no copies; samples read only visible faces. */
export function loadFontSample(entry: FontPickerEntry): Promise<Preview> {
  const cacheKey = entry.face ? `${entry.key}:${entry.face.faceId}`
    : entry.asset ? `${entry.key}:${entry.asset.src}:${entry.asset.sourceContentHash ?? ''}` : entry.key;
  const hit = samples.get(cacheKey);
  if (hit) return hit;
  const run = async (): Promise<Preview> => {
    if (entry.asset) {
      await ensureAssetFont(entry.asset);
      return { family: assetFontFamily(entry.asset.id) };
    }
    if (!entry.face) {
      await ensureFont(entry.family);
      return { family: entry.family };
    }
    const api = window.openChatCutDesktop?.fonts;
    if (!api) throw new Error('本机字体需要桌面版');
    const { bytes, face: metadata } = await api.previewFont(entry.face.faceId);
    const source = new Uint8Array(bytes).slice().buffer;
    const family = `cc-preview-${entry.face.faceId}`;
    const face = new FontFace(family, source, { weight: String(metadata.weight), style: metadata.style });
    await face.load();
    document.fonts.add(face);
    const result = { family, face };
    loaded.set(cacheKey, result);
    // Fonts borrowed only for browsing are bounded; project fonts remain registered.
    while (loaded.size > 24) {
      const key = loaded.keys().next().value!;
      const old = loaded.get(key);
      if (old?.face) document.fonts.delete(old.face);
      loaded.delete(key); samples.delete(key);
    }
    return result;
  };
  const promise = queue.then(run).catch((error: unknown) => { samples.delete(cacheKey); throw error; });
  queue = promise.catch(() => undefined);
  samples.set(cacheKey, promise);
  return promise;
}
