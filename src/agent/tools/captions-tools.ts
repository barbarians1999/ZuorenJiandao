export { CAPTIONS_TOOL_SCHEMAS, CAPTIONS_TOOL_NAMES } from './schemas/captions-tools';
import type { AgentContext } from '../context';
import { captionTrackEntries, captionsOnTrack, defaultTrackId, resolveTrackId, trackAlias } from '../../editor/types';
import type { CaptionsData, CaptionWordOverride } from '../../captions/types';
import { CAPTION_MAX_CHARS_PER_LINE, CAPTION_MAX_VISUAL_LINES, paginate } from '../../captions/types';
import { isManualCaptionEntry } from '../../captions/manualCaptions';
import { orderedCaptionSourceEntries } from '../../captions/sourceOrder';
import { resolveCaptionWords, resolveCaptionWordIndices, resolveCaptionWordRefs, applyWordOverrides } from '../../captions/resolve';
import { captionWordOverride } from '../../captions/wordOverrides';
import { captionStyleFor } from '../../captions/styles';
import { editCaptions } from './captions-actions';
import { sourceList } from './captions-sources';
import { applyCaptionAvoidance } from './caption-avoidance-tools';

// Captions tools: `read_captions` (read-only) + `edit_captions`
// (ONE tool, 21-action dispatch — see captions-actions.ts). Word overrides
// (display_text), multi-source routing (source_*), and language (language_mode /
// bilingual) are all edit_captions actions now; the old flat edit_captions and the
// edit_caption_words / set_caption_sources behavior is folded in.


type Args = Record<string, unknown>;

const AUTO_AVOIDANCE_ACTIONS: Record<string, true> = {
  enable: true,
  source_set: true,
  source_add: true,
};

function collectManualCues(c: CaptionsData): Array<{
  cueId: string | null;
  laneId: string;
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}> {
  if (!c.sourceEntries?.length) return [];
  const out: Array<{
    cueId: string | null;
    laneId: string;
    index: number;
    text: string;
    startMs: number;
    endMs: number;
  }> = [];
  for (const entry of orderedCaptionSourceEntries(c.sourceEntries)) {
    if (!isManualCaptionEntry(entry)) continue;
    (entry.words ?? []).forEach((word, index) => {
      out.push({
        cueId: word.id ?? null,
        laneId: entry.id,
        index,
        text: word.text,
        startMs: word.start,
        endMs: word.end,
      });
    });
  }
  return out;
}

function hasSkipFlag(record: Record<string, unknown>): boolean {
  return record.skipAvoidance === true
    || record.skipAutoAvoidance === true
    || record.avoidance === false
    || record.avoidance === 'off';
}

function shouldSkipAvoidance(args: Args): boolean {
  if (hasSkipFlag(args)) return true;
  const rawJson = args.json;
  if (rawJson && typeof rawJson === 'object' && !Array.isArray(rawJson)) {
    return hasSkipFlag(rawJson as Record<string, unknown>);
  }
  if (typeof rawJson === 'string' && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return hasSkipFlag(parsed as Record<string, unknown>);
      }
    } catch {
      return false;
    }
  }
  return false;
}

export async function execCaptionsTool(name: string, args: Args, ctx: AgentContext): Promise<unknown | undefined> {
  const s = ctx.getState();
  const requested = String(args.captionTrackId ?? args.captionsItemId ?? '').trim();
  const target = requested ? resolveTrackId(s, requested, 'caption') : defaultTrackId(s, 'caption');
  const c = target ? captionsOnTrack(s, target) : s.captions ?? null;

  switch (name) {
    case 'read_captions': {
      if (args.list === true) return {
        tracks: captionTrackEntries(s).map((entry) => ({
          id: entry.id,
          alias: trackAlias(s, entry.id),
          name: s.tracks?.[entry.id]?.name ?? null,
          enabled: entry.captions?.enabled ?? false,
          hasCaptions: !!entry.captions,
        })),
      };
      if (requested && !target) return { error: `no caption track ${requested}` };
      if (!c || !c.enabled) return { enabled: false, note: 'captions are off; call edit_captions to turn them on first' };
      const manualCues = collectManualCues(c);
      const hasManualLane = Boolean(c.sourceEntries?.some(isManualCaptionEntry));
      const words = resolveCaptionWords(c, s.items, s.fps);
      if (!words.length) return {
        enabled: true,
        captionTrackId: target,
        captionTrackAlias: target ? trackAlias(s, target) : null,
        template: c.template,
        pacing: c.pacing,
        motionPreset: c.motionPreset ?? 'none',
        ...(c.sourceEntries?.length ? { sources: sourceList(c, s).sources } : {}),
        ...(hasManualLane ? { manualCues } : {}),
        note: hasManualLane
          ? 'manual caption track has no cues yet; use edit_captions action=cue_add'
          : 'source track has no transcript words',
      };
      const indices = resolveCaptionWordIndices(c, s.items, s.fps);
      const wordRefs = resolveCaptionWordRefs(c, s.items, s.fps);
      const item = c.sourceItemId ? s.items.find((it) => it.id === c.sourceItemId) : undefined;
      // Do not throw hidden words here - just do text replacement/page change, so that the agent can see the subscript + status of the hidden words on the page, so that it can be conveniently decided whether to unhide it.
      let visibleOverrides: Record<number, CaptionWordOverride> | undefined;
      if (c.wordOverrides) {
        visibleOverrides = {};
        for (const [k, v] of Object.entries(c.wordOverrides)) visibleOverrides[Number(k)] = { ...v, hidden: false };
      }
      const applied = applyWordOverrides(words, indices, visibleOverrides, wordRefs);
      const wordsPerPage = captionStyleFor(c.template).wordsPerPage;
      const allManual = hasManualLane && (c.sourceEntries?.every(isManualCaptionEntry) ?? false);
      const pages = allManual
        ? applied.words.map((w) => ({ words: [w], start: w.start, end: w.end }))
        : paginate(
            applied.words,
            c.pacing,
            wordsPerPage,
            applied.breakBefore,
            CAPTION_MAX_CHARS_PER_LINE,
            CAPTION_MAX_VISUAL_LINES,
          );
      let cursor = 0;
      const pagesOut = pages.map((p) => ({
        start: p.start,
        end: p.end,
        words: p.words.map((w) => {
          const position = cursor++;
          return {
            index: applied.indices[position],
            wordRef: applied.wordRefs[position],
            text: w.text,
            override: captionWordOverride(c.wordOverrides, applied.indices[position]!, applied.wordRefs[position]!) ?? null,
          };
        }),
      }));
      return {
        enabled: true,
        captionTrackId: target,
        captionTrackAlias: target ? trackAlias(s, target) : null,
        template: c.template,
        pacing: c.pacing,
        motionPreset: c.motionPreset ?? 'none',
        track: item ? trackAlias(s, item.track) : null,
        ...(c.sourceEntries?.length ? { sources: sourceList(c, s).sources } : {}),
        ...(hasManualLane ? { manualCues } : {}),
        pageCount: pagesOut.length,
        pages: pagesOut,
      };
    }
    case 'edit_captions': {
      const result = await editCaptions(args, ctx);
      const action = String(args.action ?? '');
      if (!AUTO_AVOIDANCE_ACTIONS[action] || 'error' in result) return result;
      if (shouldSkipAvoidance(args)) {
        return {
          ...result,
          automaticCaptionAvoidance: {
            ok: true,
            skipped: true,
            note: 'skipped by skipAvoidance',
          },
        };
      }
      const automaticCaptionAvoidance = await applyCaptionAvoidance(ctx, { maxSamples: 60 });
      return { ...result, automaticCaptionAvoidance };
    }
    default:
      return undefined;
  }
}
