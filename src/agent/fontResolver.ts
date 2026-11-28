import { fontAssetMetadata } from '../../shared/desktop-fonts';
import type { MediaAsset } from '../editor/mediaTypes';
import { ensureAssetFont } from '../fonts/assetFonts';
import {
  type AgentFontSearchHit,
  matchDesktopFontFace,
  matchFontAsset,
  searchLocalFontEntries,
} from '../fonts/fontLookup';
import {
  isGenericFontFamily,
  isLoadableFontFamily,
  resolveCanonicalFamily,
} from '../fonts/googleFontCatalog';
import type { AgentContext } from './context';

export interface ResolvedAgentFont {
  fontFamily: string;
  fontAssetId?: string;
  asset?: MediaAsset;
  source: 'bundled' | 'google' | 'generic' | 'project' | 'imported' | 'system';
}

export interface AgentFontResolver {
  searchLocalFonts(query: string, projectAssets: readonly MediaAsset[], limit?: number): Promise<AgentFontSearchHit[]>;
  resolveFont(
    rawFamily: string,
    projectAssets: readonly MediaAsset[],
    preferredWeight?: number,
  ): Promise<ResolvedAgentFont | null>;
}

const BUNDLED_UI_FONTS = new Set(['geist', 'ioskeleymono', 'ioskeley mono']);

function primaryFamily(raw: string): string {
  return raw.split(',')[0]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

async function tryEnsureBrowserAssetFont(asset: MediaAsset): Promise<void> {
  if (typeof document === 'undefined') return;
  try {
    await ensureAssetFont(asset);
  } catch {
    // Timeline readiness gate retries loading on render.
  }
}

export function createBrowserFontResolver(): AgentFontResolver {
  return {
    async searchLocalFonts(query, projectAssets, limit = 25) {
      const desktop = typeof window === 'undefined' ? undefined : window.openChatCutDesktop?.fonts;
      const [importedAssets, systemCatalog] = await Promise.all([
        desktop?.listImportedFonts?.().catch(() => []) ?? Promise.resolve([]),
        desktop?.listSystemFonts?.(false).catch(() => ({ faces: [], unreadableFiles: 0 })) ?? Promise.resolve({ faces: [], unreadableFiles: 0 }),
      ]);
      return searchLocalFontEntries(query, projectAssets, importedAssets, systemCatalog.faces, limit);
    },

    async resolveFont(rawFamily, projectAssets, preferredWeight = 400) {
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

      const desktop = typeof window === 'undefined' ? undefined : window.openChatCutDesktop?.fonts;
      if (!desktop) return null;

      const importedAssets = await desktop.listImportedFonts?.().catch(() => []) ?? [];
      const importedHit = matchFontAsset(importedAssets, first, preferredWeight);
      if (importedHit) {
        await tryEnsureBrowserAssetFont(importedHit);
        const meta = fontAssetMetadata(importedHit)!;
        return { fontFamily: meta.family, fontAssetId: importedHit.id, asset: importedHit, source: 'imported' };
      }

      const catalog = await desktop.listSystemFonts?.(false).catch(() => null);
      if (!catalog?.faces.length) return null;
      const systemHit = matchDesktopFontFace(catalog.faces, first, preferredWeight);
      if (!systemHit) return null;

      const asset = await desktop.materializeFont(systemHit.faceId);
      await tryEnsureBrowserAssetFont(asset);
      const meta = fontAssetMetadata(asset)!;
      return { fontFamily: meta.family, fontAssetId: asset.id, asset, source: 'system' };
    },
  };
}

const defaultBrowserFontResolver = createBrowserFontResolver();

export function getAgentFontResolver(ctx: Pick<AgentContext, 'fontResolver'>): AgentFontResolver {
  return ctx.fontResolver ?? defaultBrowserFontResolver;
}

export async function resolvePropsFont(
  props: Record<string, unknown>,
  ctx: Pick<AgentContext, 'fontResolver' | 'getDoc'>,
): Promise<{ props: Record<string, unknown>; asset?: MediaAsset }> {
  if (typeof props.fontFamily !== 'string' || !props.fontFamily.trim() || props.fontAssetId !== undefined) {
    return { props };
  }
  const preferredWeight = typeof props.fontWeight === 'number' && Number.isFinite(props.fontWeight) ? props.fontWeight : 400;
  const projectAssets = ctx.getDoc().assets ?? [];
  const resolved = await getAgentFontResolver(ctx).resolveFont(props.fontFamily, projectAssets, preferredWeight);
  if (!resolved?.fontAssetId) return { props };
  return {
    props: {
      ...props,
      fontFamily: resolved.fontFamily,
      fontAssetId: resolved.fontAssetId,
    },
    ...(resolved.asset && !projectAssets.some((asset) => asset.id === resolved.asset!.id)
      ? { asset: resolved.asset }
      : {}),
  };
}

export async function resolveUpdateItemPropsArgs(
  args: Record<string, unknown>,
  ctx: Pick<AgentContext, 'fontResolver' | 'getDoc' | 'getState' | 'commands'>,
): Promise<Record<string, unknown>> {
  const rawProps = args.props;
  if (!rawProps || typeof rawProps !== 'object' || Array.isArray(rawProps)) return args;
  const query = String(args.itemId ?? '');
  const item = ctx.getState().items.find((entry) => entry.id === query || (query.length > 0 && entry.id.startsWith(query)));
  if (!item || (item.kind !== 'text' && item.kind !== 'motion-graphic')) return args;
  const { props, asset } = await resolvePropsFont(rawProps as Record<string, unknown>, ctx);
  if (props === rawProps) return args;
  if (asset && !ctx.getDoc().assets.some((entry) => entry.id === asset.id)) {
    ctx.commands.addAsset(asset);
  }
  return { ...args, props };
}

async function resolveEntryFontFields(
  entry: Record<string, unknown>,
  isTextOrMg: boolean,
  resolver: AgentFontResolver,
  projectAssets: readonly MediaAsset[],
  resolvedAssets: Map<string, MediaAsset>,
): Promise<Record<string, unknown>> {
  if (!isTextOrMg) return entry;
  let nextEntry = entry;
  const rawProps = entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props)
    ? entry.props as Record<string, unknown>
    : null;
  const preferredWeight = typeof entry.fontWeight === 'number' && Number.isFinite(entry.fontWeight)
    ? entry.fontWeight
    : (typeof rawProps?.fontWeight === 'number' && Number.isFinite(rawProps.fontWeight) ? rawProps.fontWeight : 400);

  if (typeof entry.fontFamily === 'string' && entry.fontFamily.trim() && entry.fontAssetId === undefined) {
    const resolved = await resolver.resolveFont(entry.fontFamily, projectAssets, preferredWeight);
    if (resolved?.fontAssetId) {
      nextEntry = { ...nextEntry, fontFamily: resolved.fontFamily, fontAssetId: resolved.fontAssetId };
      if (resolved.asset && !projectAssets.some((asset) => asset.id === resolved.asset!.id)) {
        resolvedAssets.set(resolved.asset.id, resolved.asset);
      }
    }
  }

  if (rawProps && typeof rawProps.fontFamily === 'string' && rawProps.fontFamily.trim() && rawProps.fontAssetId === undefined) {
    const resolved = await resolver.resolveFont(rawProps.fontFamily, projectAssets, preferredWeight);
    if (resolved?.fontAssetId) {
      nextEntry = {
        ...nextEntry,
        props: { ...rawProps, fontFamily: resolved.fontFamily, fontAssetId: resolved.fontAssetId },
      };
      if (resolved.asset && !projectAssets.some((asset) => asset.id === resolved.asset!.id)) {
        resolvedAssets.set(resolved.asset.id, resolved.asset);
      }
    }
  }

  return nextEntry;
}

export async function resolveEditItemFonts(
  args: Record<string, unknown>,
  ctx: Pick<AgentContext, 'fontResolver' | 'getDoc' | 'getState'>,
): Promise<{ args: Record<string, unknown>; resolvedAssets: MediaAsset[] }> {
  const resolver = getAgentFontResolver(ctx);
  const projectAssets = ctx.getDoc().assets ?? [];
  const stateItems = ctx.getState().items;
  const resolvedAssets = new Map<string, MediaAsset>();
  let nextArgs = args;

  const adds = args.adds;
  if (Array.isArray(adds)) {
    const nextAdds = await Promise.all(adds.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const entry = raw as Record<string, unknown>;
      const isTextOrMg = entry.type === 'text' || entry.type === 'motion-graphic';
      return resolveEntryFontFields(entry, isTextOrMg, resolver, projectAssets, resolvedAssets);
    }));
    if (nextAdds.some((entry, idx) => entry !== adds[idx])) {
      nextArgs = { ...nextArgs, adds: nextAdds };
    }
  }

  const updates = args.updates;
  if (Array.isArray(updates)) {
    const nextUpdates = await Promise.all(updates.map(async (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
      const entry = raw as Record<string, unknown>;
      const query = String(entry.itemId ?? entry.id ?? '');
      const liveItem = query ? stateItems.find((item) => item.id === query || item.id.startsWith(query)) : undefined;
      const kind = typeof entry.type === 'string' ? entry.type : liveItem?.kind;
      const isTextOrMg = kind === 'text' || kind === 'motion-graphic';
      return resolveEntryFontFields(entry, isTextOrMg, resolver, projectAssets, resolvedAssets);
    }));
    if (nextUpdates.some((entry, idx) => entry !== updates[idx])) {
      nextArgs = { ...nextArgs, updates: nextUpdates };
    }
  }

  return { args: nextArgs, resolvedAssets: [...resolvedAssets.values()] };
}
