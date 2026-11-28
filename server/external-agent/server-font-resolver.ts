import { createDesktopFontLibrary } from '../../desktop/font-library.ts';
import { fontAssetMetadata } from '../../shared/desktop-fonts.js';
import type { AgentFontResolver } from '../../src/agent/fontResolver.js';
import type { MediaAsset } from '../../src/editor/mediaTypes.js';
import {
  matchDesktopFontFace,
  matchFontAsset,
  searchLocalFontEntries,
} from '../../src/fonts/fontLookup.js';
import {
  isGenericFontFamily,
  isLoadableFontFamily,
  resolveCanonicalFamily,
} from '../../src/fonts/googleFontCatalog.js';

const BUNDLED_UI_FONTS = new Set(['geist', 'ioskeleymono', 'ioskeley mono']);

function primaryFamily(raw: string): string {
  return raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

export function createServerFontResolver(
  library: ReturnType<typeof createDesktopFontLibrary> = createDesktopFontLibrary(),
): AgentFontResolver {
  return {
    async searchLocalFonts(query, projectAssets: readonly MediaAsset[], limit = 25) {
      const [importedAssets, systemCatalog] = await Promise.all([
        library.listImportedFonts().catch(() => []),
        library.listSystemFonts(false).catch(() => ({ faces: [], unreadableFiles: 0 })),
      ]);
      return searchLocalFontEntries(query, projectAssets, importedAssets, systemCatalog.faces, limit);
    },

    async resolveFont(rawFamily, projectAssets: readonly MediaAsset[], preferredWeight = 400) {
      const trimmed = rawFamily.trim();
      const first = primaryFamily(trimmed);
      if (!first) return null;

      if (BUNDLED_UI_FONTS.has(first.toLowerCase()) || isLoadableFontFamily(first)) {
        const canonical = resolveCanonicalFamily(first);
        return {
          fontFamily: canonical ?? trimmed,
          source: isGenericFontFamily(first) ? 'generic' : 'bundled',
        };
      }

      const projectHit = matchFontAsset(projectAssets, first, preferredWeight);
      if (projectHit) {
        const meta = fontAssetMetadata(projectHit)!;
        return { fontFamily: meta.family, fontAssetId: projectHit.id, source: 'project' };
      }

      const importedAssets = await library.listImportedFonts().catch(() => []);
      const importedHit = matchFontAsset(importedAssets, first, preferredWeight);
      if (importedHit) {
        const meta = fontAssetMetadata(importedHit)!;
        return { fontFamily: meta.family, fontAssetId: importedHit.id, asset: importedHit, source: 'imported' };
      }

      const catalog = await library.listSystemFonts(false).catch(() => null);
      if (!catalog?.faces.length) return null;
      const systemHit = matchDesktopFontFace(catalog.faces, first, preferredWeight);
      if (!systemHit) return null;

      const asset = await library.materializeFont(systemHit.faceId);
      const meta = fontAssetMetadata(asset)!;
      return { fontFamily: meta.family, fontAssetId: asset.id, asset, source: 'system' };
    },
  };
}

let sharedServerFontResolver: AgentFontResolver | undefined;

export function getServerFontResolver(): AgentFontResolver {
  return (sharedServerFontResolver ??= createServerFontResolver());
}
