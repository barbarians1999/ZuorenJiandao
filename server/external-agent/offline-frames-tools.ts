import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentContext } from '../../src/agent/context.js';
import { resolveTimeline } from '../../src/agent/tools/timeline-target.js';
import {
  type ProjectDoc,
  type TimelineItem,
  type TimelineState,
  defaultTrackId,
} from '../../src/editor/types.js';
import { resolveTimelineRenderPlan } from '../../src/editor/sequenceGraph.js';
import { execFontTool } from '../../src/agent/tools/font-tools.js';
import { EXPLAINER_TEMPLATES } from '../../src/library/explainerTemplates.js';
import { getServerFontResolver } from './server-font-resolver.ts';
import { PAPER_BACKGROUND_PRESETS } from '../../src/editor/paperBackgrounds.js';
import { TRANSITION_LABELS, TRANSITION_ORDER } from '../../src/editor/transitionTypes.js';
import { prepareBrowserRenderSnapshots } from '../../src/agent/tools/renderSnapshotMedia.js';
import { ffmpegBin } from '../media-binaries.ts';
import { formatFrameLabel, formatTimeLabel, tileContactSheet } from '../frame-grid.ts';
import { resolveUploadFile } from '../media-dir.ts';

type Args = Record<string, unknown>;

export const OFFLINE_FRAMES_TOOL_NAMES = new Set([
  'view_timeline_frames',
  'view_asset_frames',
  'search_fonts',
  'browse_library',
  'list_templates',
  'search_templates',
]);

const MAX_FRAMES = 8;

function pickFrames(args: Args, total: number, fps: number, defaultCount: number): number[] {
  let frames: number[];
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    frames = args.sourceTimesMs.map((ms) => Math.round((Number(ms) / 1000) * fps));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    frames = args.frames.map(Number);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    frames = args.seconds.map((s) => Math.round(Number(s) * fps));
  } else {
    const fromS = typeof args.fromSeconds === 'number' ? args.fromSeconds : null;
    const toS = typeof args.toSeconds === 'number' ? args.toSeconds : null;
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || defaultCount)));
    if (fromS != null && toS != null && toS > fromS) {
      const fromF = Math.max(0, Math.round(fromS * fps));
      const toF = Math.min(total, Math.round(toS * fps));
      const span = Math.max(1, toF - fromF);
      frames = Array.from({ length: count }, (_, i) => fromF + Math.round(((i + 0.5) / count) * span));
    } else {
      frames = Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) / count) * Math.max(1, total)));
    }
  }
  return [...new Set(
    frames.map((f) => Math.max(0, Math.min(Math.max(0, total - 1), Math.round(f)))),
  )].sort((a, b) => a - b).slice(0, MAX_FRAMES);
}

async function renderOfflineStills(
  state: TimelineState,
  frames: number[],
  note: string,
  origin: string,
  project?: ProjectDoc,
  timelineId?: string,
): Promise<Record<string, unknown>> {
  const prepared = await prepareBrowserRenderSnapshots({ state, project, timelineId });
  const baseOrigin = origin.replace(/\/+$/, '');
  if (baseOrigin) {
    const res = await fetch(`${baseOrigin}/render-still`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: prepared.state,
        ...(prepared.project !== undefined ? { project: prepared.project } : {}),
        ...(timelineId ? { timelineId } : {}),
        frames,
        grid: frames.length >= 2,
        fps: state.fps,
      }),
    });
    if (!res.ok) {
      return { error: `offline render-still HTTP ${res.status}: ${await res.text()}` };
    }
    const data = (await res.json()) as {
      frames: Array<{ frame: number; base64: string }>;
      gridBase64?: string;
      renderedBy?: string;
    };
    const isGrid = Boolean(data.gridBase64) && data.frames.length >= 2;
    const labelLine = data.frames.map((f, i) => `[${i + 1}]${formatFrameLabel(f.frame, state.fps)}`).join(' ');
    return {
      __images: isGrid ? [{ frame: data.frames[0]?.frame ?? 0, base64: data.gridBase64! }] : data.frames,
      frames: data.frames.map((f) => f.frame),
      layout: isGrid ? 'contact_sheet' : 'individual',
      note: isGrid ? `${note} · cells L→R T→B: ${labelLine}` : note,
      renderedBy: data.renderedBy ?? 'remotion',
    };
  }
  const { renderTimelineStills } = await import('../plugins/export-rendering.ts');
  const rendered = await renderTimelineStills({
    state: prepared.state,
    project: prepared.project,
    timelineId,
    frames,
  }) as Array<{ frame: number; base64: string }>;
  let gridBase64: string | undefined;
  if (rendered.length >= 2) {
    try {
      const sheet = await tileContactSheet(rendered.map((r) => ({
        jpeg: Buffer.from(r.base64, 'base64'),
        label: formatFrameLabel(r.frame, state.fps),
      })));
      gridBase64 = sheet.toString('base64');
    } catch {
      gridBase64 = undefined;
    }
  }
  const isGrid = Boolean(gridBase64) && rendered.length >= 2;
  const labelLine = rendered.map((f, i) => `[${i + 1}]${formatFrameLabel(f.frame, state.fps)}`).join(' ');
  return {
    __images: isGrid ? [{ frame: rendered[0]?.frame ?? 0, base64: gridBase64! }] : rendered,
    frames: rendered.map((f) => f.frame),
    layout: isGrid ? 'contact_sheet' : 'individual',
    note: isGrid ? `${note} · cells L→R T→B: ${labelLine}` : note,
    renderedBy: 'remotion',
  };
}

function runFfmpegBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-2000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function execOfflineViewTimelineFrames(args: Args, ctx: AgentContext, origin: string): Promise<unknown> {
  const project = ctx.getDoc();
  let state;
  let total;
  try {
    state = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
    total = resolveTimelineRenderPlan(project, state.id).durationInFrames;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (total <= 0 || !state.items.length) {
    return { error: 'timeline is empty — nothing to render' };
  }
  const frames = pickFrames(args, total, state.fps, 4);
  const note = `时间线「${state.name}」${frames.length} 帧（绝对时间线坐标 f${frames.join(', f')}，共 ${total} @${state.fps}fps）——离线合成预览画面`;
  const rendered = await renderOfflineStills(state, frames, note, origin, project, state.id);
  return 'error' in rendered
    ? rendered
    : { ...rendered, coordinateSpace: 'timeline', timelineId: state.id };
}

async function execOfflineViewAssetFrames(args: Args, ctx: AgentContext, origin: string): Promise<unknown> {
  const doc = ctx.getDoc();
  const base = ctx.getState();
  const fps = base.fps || 30;
  let item: TimelineItem | undefined;
  let asset = undefined as (typeof doc.assets)[number] | undefined;
  if (typeof args.itemId === 'string' && args.itemId.trim()) {
    const q = args.itemId.trim();
    const tl = resolveTimeline(ctx, typeof args.timelineId === 'string' ? args.timelineId : undefined);
    item = tl.items.find((entry) => entry.id === q || entry.id.startsWith(q));
    if (!item) return { error: `item not found: ${q}` };
    asset = doc.assets.find((a) => a.id === item!.sourceAssetId)
      ?? (item.src ? doc.assets.find((a) => a.src === item!.src) : undefined);
  } else if (typeof args.assetId === 'string' && args.assetId.trim()) {
    const q = args.assetId.trim();
    asset = doc.assets.find((a) => a.id === q) ?? doc.assets.find((a) => a.id.startsWith(q));
    if (!asset) return { error: `asset not found: ${q}` };
  } else {
    return { error: 'pass assetId or itemId' };
  }
  if (!asset) return { error: 'no source asset backing this item' };
  if (asset.kind === 'audio') return { error: `asset "${asset.name}" is audio — it has no frames to render` };

  const baseOrigin = origin.replace(/\/+$/, '');
  if ((asset.kind === 'video' || asset.kind === 'gif') && asset.src?.startsWith('/media/uploads/') && baseOrigin) {
    try {
      const res = await fetch(`${baseOrigin}/api/extract-frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          src: asset.src,
          fps,
          ...(Array.isArray(args.sourceTimesMs) ? { sourceTimesMs: args.sourceTimesMs } : {}),
          ...(typeof args.count === 'number' ? { count: args.count } : {}),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { base64?: string; sampleCount?: number; sourceTimesMs?: number[]; labels?: string[] };
        if (data.base64) {
          const times = data.sourceTimesMs ?? [];
          return {
            __images: [{ frame: 0, base64: data.base64 }],
            frames: times.length ? times.map((ms) => Math.round((ms / 1000) * fps)) : [0],
            layout: (data.sampleCount ?? 1) > 1 ? 'contact_sheet' : 'individual',
            note: `源资产「${asset.name}」contact sheet`,
            renderedBy: 'ffmpeg',
            coordinateSpace: 'source',
            assetId: asset.id,
          };
        }
      }
    } catch {
      // Fall back to direct file / Remotion still
    }
  }

  const localPath = asset.src?.startsWith('/media/uploads/')
    ? resolveUploadFile(asset.src)
    : asset.originalFilePath;
  if (asset.kind === 'image' && localPath) {
    const ext = extname(localPath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png' || ext === '.webp') {
      try {
        const jpeg = ext === '.jpg' || ext === '.jpeg'
          ? await readFile(localPath)
          : await runFfmpegBuffer(['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', localPath, '-vframes', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', 'pipe:1']);
        return {
          __images: [{ frame: 0, base64: jpeg.toString('base64') }],
          frames: [0],
          layout: 'individual',
          note: `源资产「${asset.name}」图片预览`,
          renderedBy: 'ffmpeg',
          coordinateSpace: 'source',
          assetId: asset.id,
        };
      } catch {
        // Fall through to Remotion still
      }
    }
  }
  if ((asset.kind === 'video' || asset.kind === 'gif') && localPath) {
    try {
      const totalMs = Math.max(200, Math.round((asset.durationInFrames / fps) * 1000));
      const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || 4)));
      const timesMs = Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length
        ? args.sourceTimesMs.map((v) => Math.max(0, Math.round(Number(v)))).slice(0, MAX_FRAMES)
        : Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) / count) * totalMs));
      const cells = [];
      for (const ms of timesMs) {
        const jpeg = await runFfmpegBuffer([
          '-nostdin', '-hide_banner', '-loglevel', 'error',
          '-ss', (ms / 1000).toFixed(3), '-i', localPath,
          '-vframes', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1',
        ]);
        cells.push({ jpeg, label: formatTimeLabel(ms) });
      }
      const grid = cells.length >= 2 ? await tileContactSheet(cells) : cells[0]?.jpeg;
      if (grid) {
        return {
          __images: [{ frame: 0, base64: grid.toString('base64') }],
          frames: timesMs.map((ms) => Math.round((ms / 1000) * fps)),
          layout: cells.length >= 2 ? 'contact_sheet' : 'individual',
          note: `源资产「${asset.name}」offline ffmpeg`,
          renderedBy: 'ffmpeg',
          coordinateSpace: 'source',
          assetId: asset.id,
        };
      }
    } catch {
      // Fall through to Remotion still
    }
  }

  const track = defaultTrackId(base, 'video');
  if (!track) return { error: 'no video track' };
  const total = Math.max(1, asset.durationInFrames);
  const frames = pickFrames(args, total, fps, 1);
  const previewState: TimelineState = {
    ...base,
    width: asset.width ?? base.width,
    height: asset.height ?? base.height,
    items: [
      asset.kind === 'motion-graphic'
        ? {
            id: `preview_${asset.id}`,
            track,
            startFrame: 0,
            durationInFrames: total,
            name: asset.name,
            kind: 'motion-graphic',
            templateId: asset.id,
            code: asset.code,
            props: asset.props ?? {},
            width: asset.width,
            height: asset.height,
          }
        : {
            id: `preview_${asset.id}`,
            track,
            startFrame: 0,
            durationInFrames: total,
            name: asset.name,
            kind: asset.kind === 'svg' ? 'svg' : asset.kind === 'video' ? 'video' : 'image',
            src: asset.src,
            width: asset.width,
            height: asset.height,
          },
    ],
    transitions: [],
    markers: [],
    selectedId: null,
  };
  return renderOfflineStills(previewState, frames, `源资产「${asset.name}」`, origin);
}

function execOfflineBrowseLibrary(args: Args): unknown {
  const category = typeof args.category === 'string' ? args.category : undefined;
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id) {
    const mg = EXPLAINER_TEMPLATES.find((t) => t.id === id);
    if (mg) {
      return {
        id: mg.id,
        category: 'motion-graphics',
        name: mg.name,
        description: mg.description,
        durationInFrames: mg.durationInFrames,
        props: mg.props,
        propSchema: mg.propSchema,
        usage: { tool: 'edit_item', adds: [{ type: 'motion-graphic', assetId: `library:motion-graphic:${mg.id}`, props: {} }] },
      };
    }
    const tr = TRANSITION_ORDER.find((t) => `builtin:tr-${t}` === id || t === id);
    if (tr) {
      return {
        id: `builtin:tr-${tr}`,
        category: 'transitions',
        name: TRANSITION_LABELS[tr],
        usage: { tool: 'edit_item', adds: [{ type: 'transition', assetId: `builtin:tr-${tr}`, incomingItemId: '<itemId>' }] },
      };
    }
    return { error: `offline library entry "${id}" not found or requires browser editor` };
  }
  const items: Array<{ id: string; category: string; name: string; description?: string }> = [];
  if (!category || category === 'motion-graphics') {
    for (const mg of EXPLAINER_TEMPLATES) {
      items.push({ id: `library:motion-graphic:${mg.id}`, category: 'motion-graphics', name: mg.name, description: mg.description });
    }
  }
  if (!category || category === 'transitions') {
    for (const tr of TRANSITION_ORDER) {
      items.push({ id: `builtin:tr-${tr}`, category: 'transitions', name: TRANSITION_LABELS[tr] });
    }
  }
  if (!category) {
    for (const preset of PAPER_BACKGROUND_PRESETS) {
      items.push({ id: `paper:${preset.id}`, category: 'papers', name: preset.label, description: '径向渐变 + 细腻纸张颗粒背景板' });
    }
  }
  const filtered = query
    ? items.filter((entry) => `${entry.id} ${entry.name} ${entry.description ?? ''}`.toLowerCase().includes(query))
    : items;
  return { items: filtered.slice(0, 50), total: filtered.length, offlineMode: true };
}

export async function execOfflineFramesTool(
  name: string,
  args: Args,
  ctx: AgentContext,
  origin: string,
): Promise<unknown> {
  if (name === 'view_timeline_frames') return execOfflineViewTimelineFrames(args, ctx, origin);
  if (name === 'view_asset_frames') return execOfflineViewAssetFrames(args, ctx, origin);
  if (name === 'search_fonts') {
    return execFontTool('search_fonts', args, {
      ...ctx,
      fontResolver: ctx.fontResolver ?? getServerFontResolver(),
    });
  }
  if (name === 'browse_library') return execOfflineBrowseLibrary(args);
  if (name === 'list_templates') {
    const category = typeof args.category === 'string' ? args.category.toLowerCase() : null;
    if (category) {
      return EXPLAINER_TEMPLATES
        .filter((t) => t.category.toLowerCase() === category)
        .map((t) => ({ id: t.id, name: t.name }));
    }
    return { categories: { 'explainer-kits': EXPLAINER_TEMPLATES.length }, total: EXPLAINER_TEMPLATES.length };
  }
  if (name === 'search_templates') {
    const query = String(args.query ?? '').toLowerCase();
    return EXPLAINER_TEMPLATES
      .filter((t) => !query || t.name.toLowerCase().includes(query) || t.id.toLowerCase().includes(query) || (t.description ?? '').toLowerCase().includes(query))
      .map((t) => ({ id: t.id, name: t.name, category: t.category, description: t.description }));
  }
  return { error: `unknown offline frames/catalog tool ${name}` };
}
