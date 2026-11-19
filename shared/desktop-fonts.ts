import type { MediaAsset } from '../src/editor/mediaTypes.js';

export const DESKTOP_FONT_CHANNELS = {
  list: 'openchatcut:fonts-list',
  choose: 'openchatcut:fonts-choose',
  preview: 'openchatcut:fonts-preview',
  materialize: 'openchatcut:fonts-materialize',
} as const;

export interface FontFaceMetadata {
  family: string;
  fullName: string;
  postscriptName: string;
  subfamily: string;
  weight: number;
  style: 'normal' | 'italic';
  weightRange?: readonly [number, number];
  faceIndex: number;
}

export interface DesktopFontFace extends FontFaceMetadata {
  /** An opaque main-process grant, never an arbitrary filesystem path. */
  faceId: string;
  source: 'system' | 'imported';
  filename: string;
}

export interface DesktopFontCatalog {
  faces: DesktopFontFace[];
  unreadableFiles: number;
}

export interface DesktopFontPreview {
  face: DesktopFontFace;
  bytes: Uint8Array;
}

export interface DesktopFontsApi {
  listSystemFonts(refresh?: boolean): Promise<DesktopFontCatalog>;
  chooseFontFile(): Promise<DesktopFontFace[] | null>;
  previewFont(faceId: string): Promise<DesktopFontPreview>;
  materializeFont(faceId: string): Promise<MediaAsset>;
}

export interface FontAssetMetadata extends FontFaceMetadata {
  source: 'system' | 'imported';
  format: 'truetype' | 'opentype';
}

export interface FontChoice {
  fontFamily: string;
  fontAssetId?: string;
  /** New resource to add to the document in the same history gesture. */
  asset?: MediaAsset;
}

export function fontAssetMetadata(value: unknown): FontAssetMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const asset = value as Partial<MediaAsset>;
  if (asset.kind !== 'file' || asset.props?.resourceType !== 'font') return null;
  const raw = asset.props.font as Partial<FontAssetMetadata> | undefined;
  if (!raw || typeof raw.family !== 'string' || !raw.family
    || typeof raw.fullName !== 'string' || typeof raw.postscriptName !== 'string'
    || typeof raw.weight !== 'number' || !Number.isFinite(raw.weight)
    || (raw.style !== 'normal' && raw.style !== 'italic')
    || (raw.format !== 'truetype' && raw.format !== 'opentype')) return null;
  return raw as FontAssetMetadata;
}

export function isFontAsset(asset: MediaAsset): boolean {
  return fontAssetMetadata(asset) !== null;
}

/** Stable CSS identity isolates two files with identical family names. */
export function assetFontFamily(assetId: string): string {
  return `cc-font-${Array.from(assetId).map((char) => char.codePointAt(0)!.toString(16)).join('-')}`;
}

export function runtimeFontFamily(fontFamily: string, fontAssetId?: string | null): string {
  return fontAssetId ? assetFontFamily(fontAssetId) : fontFamily;
}
