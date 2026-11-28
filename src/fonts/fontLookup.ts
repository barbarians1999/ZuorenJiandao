import { fontAssetMetadata, type DesktopFontFace, type FontFaceMetadata } from '../../shared/desktop-fonts';
import type { MediaAsset } from '../editor/mediaTypes';
import { normalizeFontKey } from './localFonts';

export interface AgentFontSearchHit {
  family: string;
  fullName?: string;
  postscriptName?: string;
  aliases: string[];
  loadable: true;
  source: 'project' | 'imported' | 'system';
  fontAssetId?: string;
}

export function stripFontExt(filename: string): string {
  return filename.replace(/\.(ttf|otf|ttc)$/i, '');
}

function primaryFontToken(raw: string): string {
  return raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

function exactMatchTier(
  meta: Pick<FontFaceMetadata, 'family' | 'fullName' | 'postscriptName' | 'aliases'>,
  filename: string | undefined,
  normalizedQuery: string,
): number {
  if (!normalizedQuery) return -1;
  if (normalizeFontKey(meta.postscriptName) === normalizedQuery) return 4;
  if (normalizeFontKey(meta.fullName) === normalizedQuery) return 3;
  if (normalizeFontKey(meta.family) === normalizedQuery) return 2;
  if ((meta.aliases ?? []).some((alias) => normalizeFontKey(alias) === normalizedQuery)) return 1;
  if (filename && normalizeFontKey(stripFontExt(filename)) === normalizedQuery) return 0;
  return -1;
}

function faceScore(
  meta: Pick<FontFaceMetadata, 'family' | 'fullName' | 'postscriptName' | 'aliases' | 'weight' | 'style'>,
  filename: string | undefined,
  normalizedQuery: string,
  preferredWeight = 400,
): number {
  const tier = exactMatchTier(meta, filename, normalizedQuery);
  if (tier < 0) return -1;
  const styleBonus = meta.style === 'normal' ? 1000 : 0;
  const weightPenalty = Math.abs((meta.weight || 400) - preferredWeight);
  return tier * 100_000 + styleBonus - weightPenalty;
}

export function matchFontAsset(
  assets: readonly MediaAsset[],
  query: string,
  preferredWeight = 400,
): MediaAsset | null {
  const key = normalizeFontKey(primaryFontToken(query));
  if (!key) return null;
  let best: MediaAsset | null = null;
  let bestScore = -1;
  for (const asset of assets) {
    const meta = fontAssetMetadata(asset);
    if (!meta) continue;
    const score = faceScore(meta, asset.sourceFilename, key, preferredWeight);
    if (score > bestScore) {
      bestScore = score;
      best = asset;
    }
  }
  return best;
}

export function matchDesktopFontFace(
  faces: readonly DesktopFontFace[],
  query: string,
  preferredWeight = 400,
): DesktopFontFace | null {
  const key = normalizeFontKey(primaryFontToken(query));
  if (!key) return null;
  let best: DesktopFontFace | null = null;
  let bestScore = -1;
  for (const face of faces) {
    const score = faceScore(face, face.filename, key, preferredWeight);
    if (score > bestScore) {
      bestScore = score;
      best = face;
    }
  }
  return best;
}

function collectAliases(
  meta: Pick<FontFaceMetadata, 'family' | 'fullName' | 'postscriptName' | 'aliases'>,
  filename: string | undefined,
): string[] {
  const out = new Set<string>();
  for (const candidate of [meta.fullName, meta.postscriptName, ...(meta.aliases ?? []), filename ? stripFontExt(filename) : '']) {
    const clean = candidate.trim();
    if (clean && clean !== meta.family) out.add(clean);
  }
  return [...out];
}

export function searchLocalFontEntries(
  query: string,
  projectAssets: readonly MediaAsset[],
  importedAssets: readonly MediaAsset[],
  systemFaces: readonly DesktopFontFace[],
  limit = 25,
): AgentFontSearchHit[] {
  const normalized = normalizeFontKey(query);
  if (!normalized || limit <= 0) return [];
  const hits: AgentFontSearchHit[] = [];
  const seenSignatures = new Set<string>();

  const pushIfMatches = (
    meta: Pick<FontFaceMetadata, 'family' | 'fullName' | 'postscriptName' | 'aliases' | 'weight' | 'style'>,
    filename: string | undefined,
    source: AgentFontSearchHit['source'],
    fontAssetId?: string,
  ) => {
    if (hits.length >= limit) return;
    const aliases = collectAliases(meta, filename);
    const searchable = [meta.family, meta.fullName, meta.postscriptName, ...aliases].map(normalizeFontKey).join(' ');
    if (!searchable.includes(normalized)) return;
    const sig = `${normalizeFontKey(meta.postscriptName)}\0${normalizeFontKey(meta.fullName)}\0${meta.weight}\0${meta.style}`;
    if (seenSignatures.has(sig)) return;
    seenSignatures.add(sig);
    hits.push({
      family: meta.family,
      fullName: meta.fullName,
      postscriptName: meta.postscriptName,
      aliases,
      loadable: true,
      source,
      ...(fontAssetId ? { fontAssetId } : {}),
    });
  };

  for (const asset of projectAssets) {
    const meta = fontAssetMetadata(asset);
    if (meta) pushIfMatches(meta, asset.sourceFilename, 'project', asset.id);
  }
  for (const asset of importedAssets) {
    const meta = fontAssetMetadata(asset);
    if (meta) pushIfMatches(meta, asset.sourceFilename, 'imported', asset.id);
  }
  for (const face of systemFaces) {
    pushIfMatches(face, face.filename, face.source === 'imported' ? 'imported' : 'system');
  }
  return hits;
}
