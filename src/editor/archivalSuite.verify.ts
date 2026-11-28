import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { sampleKeyframes, splitItemKeyframes } from './keyframes';
import {
  buildImageInnerStyle,
  buildImageMaskStyle,
  hasActiveImageStyling,
  resolveImageStyling,
} from './imageStyling';
import { PAPER_BACKGROUND_PRESETS, resolvePaperBackground } from './paperBackgrounds';
import { resolveTextStyle, resolveTextTransformForTarget, textBackgroundColor, validateTextClipProps } from './textStyles';
import { resolveCanonicalFamily } from '../fonts/googleFontCatalog';
import { resolveVectorShape, validateVectorShapeProps, vectorShapeBounds } from './vectorShapes';
import { measureTextClipRect } from '../components/preview/previewTextGeometry';
import { previewCandidateGeometry } from '../components/preview/previewTransform';
import { computeScanFocusLayout } from '../library/explainerTemplates';
import { previewTextEditFields } from '../components/preview/previewTextEdit';
import { EditorConnectionRegistry } from '../../server/external-agent/broker-registry';
import { planOverlayHybridExport } from '../../shared/export-route-plan.mjs';
import { compositionPlan } from './compositionPlan';
import { planSubdraft } from './subdraft';
import { planExpandSubdraft } from './subdraftOperations';
import { makeDraft } from './store';
import type { ProjectDoc, Timeline, TimelineItem } from './types';
import { isExternalServerDirectCall } from '../agent/external-tool-policy';
import { execOfflineEditItemTool } from '../../server/external-agent/offline-edit-item';
import { execCoreDataTool } from '../agent/tools/core-data-tools';
import { execTimelineTool } from '../agent/tools/timeline-tools';
import type { AgentContext } from '../agent/context';
import { EXPLAINER_TEMPLATES } from '../library/explainerTemplates';
// @ts-expect-error ESM script module without declaration file
import { buildSparseOverlayPlan } from '../../remotion/overlay-hybrid.mjs';

// ── 1. Keyframe easing: cubicOut & springOut + splitItemKeyframes ─────────────
{
  const cubicKfs = [
    { frame: 0, value: 0, easing: 'cubicOut' as const },
    { frame: 100, value: 100 },
  ];
  const midCubic = sampleKeyframes(cubicKfs, 50);
  assert.ok(midCubic !== undefined && midCubic > 90 && midCubic < 100, `expected cubicOut fast-out (90..100) at midpoint, got ${midCubic}`);
  assert.equal(sampleKeyframes(cubicKfs, 0), 0);
  assert.equal(sampleKeyframes(cubicKfs, 100), 100);

  const springKfs = [
    { frame: 0, value: 0, easing: 'springOut' as const },
    { frame: 100, value: 100 },
  ];
  const overshoot = Math.max(...Array.from({ length: 99 }, (_, f) => sampleKeyframes(springKfs, f + 1) ?? 0));
  assert.ok(overshoot > 102, `expected springOut overshoot > 102, got ${overshoot}`);
  assert.equal(sampleKeyframes(springKfs, 100), 100);

  // Split right inside the spring overshoot window and confirm exact continuity
  const [left, right] = splitItemKeyframes({ x: springKfs }, 42);
  assert.ok(left?.x?.length === 2 && right?.x?.length === 2);
  for (let f = 0; f <= 42; f += 7) {
    assert.ok(Math.abs((sampleKeyframes(left!.x, f) ?? 0) - (sampleKeyframes(springKfs, f) ?? 0)) < 1e-4);
  }
  for (let f = 42; f <= 100; f += 7) {
    assert.ok(Math.abs((sampleKeyframes(right!.x, f - 42) ?? 0) - (sampleKeyframes(springKfs, f) ?? 0)) < 1e-4);
  }
}

// ── 2. Image cutout fade / dropShadow / archival card ─────────────────────────
{
  assert.equal(hasActiveImageStyling({}), false);
  const s = resolveImageStyling({
    bottomFade: 32,
    edgeFade: 14,
    dropShadow: true,
    dropShadowBlur: 30,
    dropShadowOpacity: 50,
    dropShadowOffsetY: 16,
    archivalCard: true,
    archivalTilt: -3,
    archivalBw: 100,
    archivalBorder: 'thin-paper',
  });
  assert.equal(hasActiveImageStyling({ bottomFade: 20 }), true);
  assert.equal(s.bottomFade, 32);
  assert.equal(s.archivalCard, true);
  const mask = buildImageMaskStyle(s);
  assert.ok(mask && typeof mask.maskImage === 'string' && mask.maskImage.includes('linear-gradient'));
  assert.equal((mask as Record<string, unknown>).maskComposite, 'intersect, intersect');
  const inner = buildImageInnerStyle(s);
  assert.ok(inner?.filter?.includes('grayscale(100%)') && inner.filter.includes('drop-shadow('));
  assert.ok(inner?.transform?.includes('rotate(-3deg)'));
  assert.ok(typeof inner?.border === 'string' && inner.border.includes('2px solid'));
}

// ── 3. Paper background presets ───────────────────────────────────────────────
{
  assert.equal(PAPER_BACKGROUND_PRESETS.length, 4);
  for (const preset of PAPER_BACKGROUND_PRESETS) {
    const resolved = resolvePaperBackground({ paperPreset: preset.id });
    assert.equal(resolved.presetId, preset.id);
    assert.equal(resolved.preset?.label, preset.label);
    assert.equal(resolved.paperGrain, preset.defaultGrain);
  }
}

// ── 4. Text dynamic strikethrough & sparse overlay plan detection ─────────────
{
  const style = resolveTextStyle({ textStylePreset: 'refute-strike' });
  assert.equal(style.strikeAnimated, true);
  assert.equal(style.strikeColor, '#c83228');
  assert.equal(style.strikeThickness, 7);

  const sparse = buildSparseOverlayPlan(
    {
      fps: 30,
      width: 1920,
      height: 1080,
      trackOrder: ['V2', 'V1'],
      tracks: { V2: { kind: 'video' }, V1: { kind: 'video' } },
      items: [
        {
          id: 'txt-refute',
          kind: 'text',
          track: 'V2',
          startFrame: 0,
          durationInFrames: 90,
          name: '批驳',
          props: { text: '旧说法', textStylePreset: 'refute-strike', strikeStartSec: 0.5, strikeDurationSec: 0.4 },
        },
      ],
    },
    0,
    90,
  );
  // Animated frames should span frames 15..27 (per-frame sampleFrame instead of 1 static span)
  const perFrameHits = sparse.spans.filter((span: { from: number; to: number; sampleFrame: number | null }) =>
    span.to - span.from === 1 && span.sampleFrame !== null && span.from >= 15 && span.from < 28);
  assert.equal(perFrameHits.length, 13);
}

// ── 5. Ink-bleed & archival-line-wipe in compositionPlan (GL & DOM fallback) ─
{
  const timeline: Timeline = {
    id: 'tl-tr',
    name: 'Transitions',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V2', 'V1'],
    tracks: { V2: { kind: 'video' }, V1: { kind: 'video' } },
    items: [
      { id: 'img-1', kind: 'image', track: 'V1', startFrame: 0, durationInFrames: 90, name: '图1', src: '/a.png', volume: 1 },
      { id: 'img-2', kind: 'image', track: 'V1', startFrame: 90, durationInFrames: 90, name: '图2', src: '/b.png', volume: 1 },
      { id: 'img-3', kind: 'image', track: 'V1', startFrame: 180, durationInFrames: 90, name: '图3', src: '/c.png', volume: 1 },
      { id: 'sol-1', kind: 'solid', track: 'V2', startFrame: 0, durationInFrames: 60, name: '纸1', volume: 1, props: { paperPreset: 'crimson-archive' } },
      { id: 'sol-2', kind: 'solid', track: 'V2', startFrame: 60, durationInFrames: 60, name: '纸2', volume: 1, props: { paperPreset: 'warm-xuan' } },
    ],
    transitions: [
      { id: 'tr-1', type: 'ink-bleed', trackId: 'V1', outgoingItemId: 'img-1', incomingItemId: 'img-2', durationInFrames: 24, originX: 0.25, originY: 0.75 },
      { id: 'tr-2', type: 'archival-line-wipe', trackId: 'V1', outgoingItemId: 'img-2', incomingItemId: 'img-3', durationInFrames: 20, direction: 'right', lineColor: '#d4af37', lineWidthPx: 3 },
      { id: 'tr-3', type: 'ink-bleed', trackId: 'V2', outgoingItemId: 'sol-1', incomingItemId: 'sol-2', durationInFrames: 20, originX: 0.5, originY: 0.5 },
    ],
  };
  const plan = compositionPlan(timeline);
  assert.equal(plan.glWindows.length, 2);
  assert.equal(plan.glWindows[0]!.type, 'ink-bleed');
  assert.equal(plan.glWindows[0]!.originX, 0.25);
  assert.equal(plan.glWindows[1]!.type, 'archival-line-wipe');
  assert.equal(plan.glWindows[1]!.lineColor, '#d4af37');
  assert.equal(plan.glWindows[1]!.lineWidthPx, 3);
  const solidEntrance = plan.entranceOf.get('sol-2');
  assert.ok(solidEntrance && solidEntrance.type === 'ink-bleed' && solidEntrance.originX === 0.5);
  const playerSelectedPlan = compositionPlan(timeline, { mode: 'player', selectedItemId: 'img-2' });
  assert.equal(playerSelectedPlan.glWindows.length, 1);
}

// ── 6. 7-layer collage pack into compound clip + A1/C1 safety + expand ────────
{
  let seq = 0;
  const uid = (prefix: string) => `${prefix}_${++seq}`;
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'main',
    timelines: [
      {
        id: 'main',
        name: '主时间线',
        order: 0,
        fps: 30,
        width: 1920,
        height: 1080,
        selectedId: null,
        trackOrder: ['T1', 'V5', 'V4', 'V3', 'V2', 'V1', 'A1'],
        tracks: {
          T1: { kind: 'video' },
          V5: { kind: 'video' },
          V4: { kind: 'video' },
          V3: { kind: 'video' },
          V2: { kind: 'video' },
          V1: { kind: 'video' },
          A1: { kind: 'audio' },
        },
        captions: {
          enabled: true,
          template: 'plain',
          pacing: 'phrase',
          sourceMode: 'timeline',
          words: [{ text: '测试字幕', start: 0, end: 1000 }],
        },
        items: [
          { id: 'bg', kind: 'solid', track: 'V2', startFrame: 0, durationInFrames: 180, name: '底纸', volume: 1 },
          { id: 'p1', kind: 'image', track: 'V3', startFrame: 10, durationInFrames: 160, name: '档案照', src: '/p1.png', volume: 1 },
          { id: 'p2', kind: 'image', track: 'V4', startFrame: 20, durationInFrames: 140, name: '人物抠图', src: '/p2.png', volume: 1 },
          { id: 'mg1', kind: 'motion-graphic', track: 'V5', startFrame: 30, durationInFrames: 120, name: '批驳框', templateId: 'zuoren-explainer-scan-focus', volume: 1 },
          { id: 'txt1', kind: 'text', track: 'T1', startFrame: 30, durationInFrames: 120, name: '出处标', volume: 1, props: { text: '资料来源' } },
          { id: 'mainClip', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 300, name: '主口播', src: '/v.mp4', volume: 1 },
          { id: 'vo', kind: 'audio', track: 'A1', startFrame: 0, durationInFrames: 300, name: '配音', src: '/a.wav', volume: 1 },
        ],
      },
    ],
  };

  const packed = planSubdraft(doc, ['bg', 'p1', 'p2', 'mg1', 'txt1'], uid, '拼贴镜头1');
  if (!packed.ok) throw new Error(packed.error);
  const parentAfter = packed.doc.timelines[0]!;
  // Packed compound clip should be named '拼贴镜头1', preserve mainClip + vo, and prune now-empty V3/V4/V5/T1 helper tracks!
  const seqItem = parentAfter.items.find((i) => i.id === packed.itemId)!;
  assert.equal(seqItem.kind, 'sequence');
  assert.equal(seqItem.name, '拼贴镜头1');
  assert.ok(parentAfter.items.some((i) => i.id === 'mainClip'));
  assert.ok(parentAfter.items.some((i) => i.id === 'vo'));
  assert.ok(!parentAfter.trackOrder!.includes('V5'));
  assert.ok(!parentAfter.trackOrder!.includes('T1'));

  const expanded = planExpandSubdraft(packed.doc, packed.itemId, uid);
  if (!expanded.ok) throw new Error(expanded.error);
  assert.equal(expanded.itemIds.length, 5);
}

// ── 7. Live & Offline MCP synchronization + manage_timelines pack/unpack ────
{
  assert.equal(isExternalServerDirectCall('edit_item', {
    adds: [{ type: 'transition', incomingItemId: 'clip-2', assetId: 'builtin:tr-ink-bleed' }],
  }), true);
  assert.equal(isExternalServerDirectCall('edit_item', {
    adds: [{ type: 'motion-graphic', assetId: 'library:motion-graphic:zuoren-explainer-scan-focus' }],
  }), true);
  assert.equal(isExternalServerDirectCall('edit_item', {
    adds: [{ type: 'transition', incomingItemId: 'clip-2', assetId: 'tr:wipe' }],
  }), false);
  assert.equal(isExternalServerDirectCall('edit_item', {
    adds: [{ type: 'motion-graphic', assetId: 'library:motion-graphic:title' }],
  }), false);

  const initialDoc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [
      { id: 'asset-img-1', kind: 'image', name: '人物', src: '/portrait.png', width: 800, height: 1000, durationInFrames: 150 },
      { id: 'asset-img-2', kind: 'image', name: '档案', src: '/doc.png', width: 1200, height: 800, durationInFrames: 150 },
    ],
    mediaFolders: [],
    activeTimelineId: 'tl-mcp',
    timelines: [
      {
        id: 'tl-mcp',
        name: 'AI 自动剪辑测试',
        order: 0,
        fps: 30,
        width: 1920,
        height: 1080,
        selectedId: null,
        trackOrder: ['V2', 'V1', 'A1'],
        tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
        items: [],
      },
    ],
  };

  const draft = makeDraft(initialDoc);
  const ctx: AgentContext = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: EXPLAINER_TEMPLATES,
    audio: [],
    capabilities: { canImportLocalPaths: false, canGenerateMedia: false, approvalMode: 'auto' },
    toolNames: [],
  } as unknown as AgentContext;

  const batchResult = await execOfflineEditItemTool('edit_item', {
    adds: [
      { type: 'image', assetId: 'asset-img-1', track: 'V1', fromFrame: 0, durationInFrames: 90 },
      { type: 'image', assetId: 'asset-img-2', track: 'V1', fromFrame: 90, durationInFrames: 90 },
      { type: 'solid', paperPreset: 'crimson-archive', track: 'V2', fromFrame: 0, durationInFrames: 90 },
      { type: 'text', text: '旧观点错误', textStylePreset: 'refute-strike', track: 'V2', fromFrame: 90, durationInFrames: 90 },
      {
        type: 'motion-graphic',
        assetId: 'library:motion-graphic:zuoren-explainer-flow-steps',
        track: 'V2',
        fromFrame: 180,
        durationInFrames: 120,
        props: { stepsText: '劳动者\n劳动资料\n劳动对象', stepTimesSec: '0.2, 1.0, 2.0' },
      },
    ],
  }, ctx) as { ok?: boolean };
  assert.equal(batchResult.ok, true);

  const itemsAfterAdd = draft.getState().items;
  const img1 = itemsAfterAdd.find((i: TimelineItem) => i.sourceAssetId === 'asset-img-1')!;
  const img2 = itemsAfterAdd.find((i: TimelineItem) => i.sourceAssetId === 'asset-img-2')!;
  const solidItem = itemsAfterAdd.find((i: TimelineItem) => i.kind === 'solid')!;
  const textItem = itemsAfterAdd.find((i: TimelineItem) => i.kind === 'text')!;
  const mgItem = itemsAfterAdd.find((i: TimelineItem) => i.kind === 'motion-graphic')!;
  assert.equal(solidItem.props?.paperPreset, 'crimson-archive');
  assert.equal(textItem.props?.textStylePreset, 'refute-strike');
  assert.equal(mgItem.templateId, 'zuoren-explainer-flow-steps');

  const updateAndTr = await execOfflineEditItemTool('edit_item', {
    adds: [
      {
        type: 'transition',
        assetId: 'builtin:tr-ink-bleed',
        incomingItemId: img2.id,
        durationInFrames: 24,
        originX: 0.3,
        originY: 0.7,
      },
    ],
    updates: [
      {
        type: 'image',
        itemId: img1.id,
        props: { bottomFade: 28, archivalCard: true, dropShadow: true },
        keyframes: {
          scale: [
            { frame: 0, value: 0.9, easing: 'springOut' },
            { frame: 30, value: 1 },
          ],
        },
      },
    ],
  }, ctx) as { ok?: boolean };
  assert.equal(updateAndTr.ok, true);
  assert.equal(draft.getState().transitions?.[0]?.type, 'ink-bleed');
  assert.equal(draft.getState().transitions?.[0]?.originX, 0.3);
  const updatedImg1 = draft.getState().items.find((i: TimelineItem) => i.id === img1.id)!;
  assert.equal(updatedImg1.props?.archivalCard, true);
  assert.equal(updatedImg1.keyframes?.scale?.[0]?.easing, 'springOut');

  const packedMcp = await execTimelineTool('manage_timelines', {
    action: 'pack_compound',
    itemIds: [solidItem.id, mgItem.id],
    name: 'MCP复合组件',
  }, ctx) as { ok?: boolean; itemId?: string };
  assert.equal(packedMcp.ok, true);
  assert.ok(packedMcp.itemId);

  const unpackedMcp = await execTimelineTool('manage_timelines', {
    action: 'unpack_compound',
    itemId: packedMcp.itemId,
  }, ctx) as { ok?: boolean; itemIds?: string[] };
  assert.equal(unpackedMcp.ok, true);
  assert.equal(unpackedMcp.itemIds?.length, 2);
}

// ── 8. Module 1–4 extended contracts ──────────────────────────────────────────
{
  // Module 1: top-left anchored text keeps fixed left margin regardless of text length; Chinese font alias; strict validation
  assert.equal(resolveCanonicalFamily('宋体'), 'Noto Serif SC');
  assert.equal(resolveCanonicalFamily('思源宋体'), 'Noto Serif SC');
  const shortStyle = resolveTextStyle({ text: '短标题', fontFamily: '思源宋体', anchor: 'top-left', textStylePreset: 'archival-tag' });
  assert.equal(shortStyle.accentBarPosition, 'left');
  assert.equal(shortStyle.align, 'left');
  assert.ok(shortStyle.fontFamily.includes('Noto Serif SC'));
  const canvasInfo = { width: 1920, height: 1080, fit: 'contain' as const };
  const rShort = measureTextClipRect(canvasInfo, { props: { text: '人力', anchor: 'top-left', fontFamily: '思源宋体' } });
  const rLong = measureTextClipRect(canvasInfo, { props: { text: '人力、物力、财力总动员（长句测试）', anchor: 'top-left', fontFamily: '思源宋体' } });
  assert.equal(rShort.x, rLong.x);
  assert.equal(rShort.y, rLong.y);
  assert.ok(rLong.width > rShort.width);
  assert.ok(validateTextClipProps({ borderLeft: '4px solid #d4af37' })?.includes('accentBarPosition'));
  assert.equal(validateTextClipProps({ text: '合规', anchor: 'top-left', accentBarPosition: 'top', fontFamily: '宋体' }), null);

  // Module 2: vector shapes (2px line / rect / arrow), single-side fade, custom paper, video compat flag
  const lineShape = resolveVectorShape({ shapeKind: 'line', strokeWidth: 2, color: '#d4af37', x1: 0.1, y1: 0.3, x2: 0.5, y2: 0.3 })!;
  assert.equal(lineShape.strokeWidth, 2);
  assert.ok(vectorShapeBounds(lineShape, 1920, 1080, 24).height >= 24);
  assert.equal(validateVectorShapeProps({ shapeKind: 'arrow', strokeWidth: 3, bidirectional: true }), null);
  assert.ok(validateVectorShapeProps({ shapeKind: 'line', strokeWidth: 40 })?.includes('1..20'));
  const sideMask = buildImageMaskStyle(resolveImageStyling({ singleSideFade: 30, fadeSide: 'bottom' }))!;
  assert.ok(String(sideMask.maskImage).includes('to bottom'));
  assert.ok(String(sideMask.maskImage).includes('70%'));
  const customPaper = resolvePaperBackground({ paperPreset: 'custom', paperCenterColor: '#801010', paperMidColor: '#550808', paperEdgeColor: '#220303', paperGrain: 25 });
  assert.equal(customPaper.presetId, 'custom');
  assert.equal(customPaper.isTextured, true);
  assert.equal(customPaper.colors[0], '#801010');
  const videoCompatRoute = planOverlayHybridExport({
    state: {
      fps: 30,
      width: 1920,
      height: 1080,
      trackOrder: ['V1'],
      tracks: { V1: { kind: 'video' } },
      items: [
        { id: 'v1', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 60, src: '/media/uploads/v.mp4', volume: 1, props: { singleSideFade: 30, archivalCard: true } },
      ],
    },
    frameRange: [0, 59],
    allowCompatSpans: true,
  });
  assert.ok(videoCompatRoute.compatReasons?.includes('video-clip-effects'));

  // Module 3: scan-focus labelText priority on double click + clean-line-wipe preserved on compound sequence clips
  const scanEditFields = previewTextEditFields({
    id: 'mg-scan',
    kind: 'motion-graphic',
    track: 'V2',
    startFrame: 0,
    durationInFrames: 90,
    name: '扫描框',
    templateId: 'zuoren-explainer-scan-focus',
    props: { labelText: '鞍钢高炉', subText: '1953年投产' },
  });
  assert.ok(scanEditFields);
  assert.equal(scanEditFields.textKey, 'labelText');
  assert.equal(scanEditFields.text, '鞍钢高炉');
  const seqState: Timeline = {
    id: 'tl-seq-tr',
    name: 'SeqTransitions',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [
      { id: 'seq1', kind: 'sequence', timelineId: 'sub1', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'Scene1', volume: 1 },
      { id: 'seq2', kind: 'sequence', timelineId: 'sub2', track: 'V1', startFrame: 90, durationInFrames: 90, name: 'Scene2', volume: 1 },
    ],
    transitions: [
      { id: 'tr-clean', type: 'clean-line-wipe', outgoingItemId: 'seq1', incomingItemId: 'seq2', trackId: 'V1', durationInFrames: 24, direction: 'left', lineColor: '#a62121', lineWidthPx: 2.5 },
    ],
  };
  const seqRenderPlan = compositionPlan(seqState, { mode: 'render' });
  const seqEntrance = seqRenderPlan.entranceOf.get('seq2');
  assert.equal(seqEntrance?.type, 'soft-wipe');
  assert.equal(seqEntrance?.line, true);
  assert.equal(seqEntrance?.lineColor, '#a62121');
  assert.equal(seqEntrance?.lineWidthPx, 2.5);

  // Module 4: explicit track V1/V5 honored without visualRole override, missing track rejected, multi-window conflict gate
  const strictDoc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'tl-strict',
    timelines: [
      {
        id: 'tl-strict',
        name: 'StrictTracks',
        order: 0,
        fps: 30,
        width: 1920,
        height: 1080,
        selectedId: null,
        trackOrder: ['V2', 'V1', 'A1'],
        tracks: { V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
        items: [],
      },
    ],
  };
  const strictDraft = makeDraft(strictDoc);
  const strictCtx: AgentContext = {
    commands: strictDraft.commands,
    getState: strictDraft.getState,
    getDoc: strictDraft.getDoc,
    getCreativeMode: () => null,
    templates: EXPLAINER_TEMPLATES,
    audio: [],
    capabilities: { canImportLocalPaths: false, canGenerateMedia: false, approvalMode: 'auto' },
    toolNames: [],
  } as unknown as AgentContext;
  const strictOk = await execOfflineEditItemTool('edit_item', {
    adds: [
      { type: 'shape', shapeKind: 'line', track: 'V1', fromFrame: 0, durationInFrames: 60, color: '#d4af37', strokeWidth: 2 },
      { type: 'text', text: '测试左对齐', track: 'V2', fromFrame: 0, durationInFrames: 60, anchor: 'top-left' },
    ],
  }, strictCtx) as { ok?: boolean; results?: Array<{ placed?: { track?: string } }> };
  assert.equal(strictOk.ok, true);
  assert.equal(strictDraft.getState().items.find((i) => i.kind === 'solid')?.track, 'V1');
  assert.equal(strictDraft.getState().items.find((i) => i.kind === 'text')?.track, 'V2');
  const missingTrackRes = await execOfflineEditItemTool('edit_item', {
    adds: [{ type: 'text', text: '错轨', track: 'V99', fromFrame: 0, durationInFrames: 30 }],
  }, strictCtx) as { error?: string };
  assert.ok(missingTrackRes.error?.includes('V99'));

  const reg = new EditorConnectionRegistry({
    bindingReplaced: () => {},
    revisionChanged: () => {},
    editorRemoved: () => {},
    wakeProject: () => {},
    hasInFlightCall: () => false,
  });
  reg.register('p1', 'ed-1', 'rev-1', [], undefined, undefined, { tabId: 'tab-desktop', clientKind: 'desktop' });
  assert.equal(reg.checkMultiWindowConflict('p1', 'tab-desktop', false).conflict, false);
  const secondWin = reg.checkMultiWindowConflict('p1', 'tab-browser', false);
  assert.equal(secondWin.conflict, true);
  assert.equal(secondWin.holderClientKind, 'desktop');
  assert.equal(reg.checkMultiWindowConflict('p1', 'tab-browser', true).conflict, false);
}

// ── 9. Text card background + accent bar & unified anchor coordinate geometry ─
{
  const stateBase: Timeline = {
    id: 'tl-coord',
    name: 'Coords',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    items: [],
  };

  // top-left target (15%, 20%) -> (288px, 216px)
  const tlTransform = resolveTextTransformForTarget('top-left', { xRatio: 0.15, yRatio: 0.2 });
  const tlItem: TimelineItem = {
    id: 't-tl',
    kind: 'text',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 60,
    name: '左上卡',
    volume: 1,
    transform: { ...tlTransform, scale: 1.4, scaleX: 1.4, scaleY: 1.4, rotation: 0 },
    props: { text: '档案条目一', anchor: 'top-left', textStylePreset: 'archival-top-tag' },
  };
  const tlGeo = previewCandidateGeometry({ ...stateBase, items: [tlItem] }, {
    item: tlItem,
    localFrame: 0,
    transform: { x: tlTransform.x, y: tlTransform.y, scale: 1.4, scaleX: 1.4, scaleY: 1.4, rotation: 0 },
  });
  assert.ok(Math.abs(tlGeo.corners[0].x - 0.15 * 1920) < 0.5, `expected top-left x=288, got ${tlGeo.corners[0].x}`);
  assert.ok(Math.abs(tlGeo.corners[0].y - 0.2 * 1080) < 0.5, `expected top-left y=216, got ${tlGeo.corners[0].y}`);

  // center target (30%, 70%) -> center at (576px, 756px)
  const cTransform = resolveTextTransformForTarget('center', { xRatio: 0.3, yRatio: 0.7 });
  const cItem: TimelineItem = {
    id: 't-c',
    kind: 'text',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 60,
    name: '居中卡',
    volume: 1,
    transform: { ...cTransform, scale: 1.2, scaleX: 1.2, scaleY: 1.2, rotation: 0 },
    props: { text: '核心结论', anchor: 'center', align: 'center' },
  };
  const cGeo = previewCandidateGeometry({ ...stateBase, items: [cItem] }, {
    item: cItem,
    localFrame: 0,
    transform: { x: cTransform.x, y: cTransform.y, scale: 1.2, scaleX: 1.2, scaleY: 1.2, rotation: 0 },
  });
  assert.ok(Math.abs(cGeo.center.x - 0.3 * 1920) < 0.5, `expected center x=576, got ${cGeo.center.x}`);
  assert.ok(Math.abs(cGeo.center.y - 0.7 * 1080) < 0.5, `expected center y=756, got ${cGeo.center.y}`);

  // Offline MCP text add with backgroundColor + top accent bar (no explicit backgroundOpacity) & preset switch from clean -> archival-top-tag
  const draft = makeDraft({
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'tl-coord',
    timelines: [stateBase],
  });
  const mcpCtx: AgentContext = {
    commands: draft.commands,
    getState: draft.getState,
    getDoc: draft.getDoc,
    getCreativeMode: () => null,
    templates: EXPLAINER_TEMPLATES,
    audio: [],
    capabilities: { canImportLocalPaths: false, canGenerateMedia: false, approvalMode: 'auto' },
    toolNames: [],
  } as unknown as AgentContext;

  const added = await execOfflineEditItemTool('edit_item', {
    adds: [
      {
        type: 'text',
        text: '宣纸顶部强调条卡',
        track: 'V1',
        fromFrame: 0,
        durationInFrames: 60,
        backgroundColor: '#f4ecda',
        accentBarPosition: 'top',
        accentBarColor: '#a62121',
        anchor: 'top-left',
      },
      {
        type: 'text',
        text: '由简洁切预设',
        track: 'V1',
        fromFrame: 60,
        durationInFrames: 60,
        textStylePreset: 'clean',
        backgroundOpacity: 0,
      },
    ],
  }, mcpCtx) as { ok?: boolean };
  assert.equal(added.ok, true);
  const items = draft.getState().items;
  const topBarCard = items[0]!;
  const switchedCard = items[1]!;
  assert.equal(textBackgroundColor(resolveTextStyle(topBarCard.props)), '#f4ecdaff');

  const propUpdate = execCoreDataTool('update_item_props', {
    itemId: switchedCard.id,
    props: { textStylePreset: 'archival-tag' },
  }, mcpCtx) as { ok?: boolean };
  assert.equal(propUpdate.ok, true);
  const updatedSwitched = draft.getState().items.find((entry) => entry.id === switchedCard.id)!;
  assert.equal(resolveTextStyle(updatedSwitched.props).backgroundOpacity, 88);
  assert.ok(textBackgroundColor(resolveTextStyle(updatedSwitched.props)));

  // Scan-focus preview hit-box with labelText:"" + custom endX/endY does not add phantom +260px label overhang
  const bareScanItem: TimelineItem = {
    id: 'mg-scan-bare',
    kind: 'motion-graphic',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
    name: '无框扫描',
    templateId: 'zuoren-explainer-scan-focus',
    volume: 1,
    props: { boxX: 35, boxY: 50, boxW: 20, boxH: 20, labelText: '', endX: 70, endY: 25 },
  };
  const scanLayout = computeScanFocusLayout(bareScanItem.props, 1920, 1080);
  assert.equal(scanLayout.hasLabelCard, false);
  const scanGeo = previewCandidateGeometry({ ...stateBase, items: [bareScanItem] }, {
    item: bareScanItem,
    localFrame: 0,
    transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
  });
  const rightEdge = scanGeo.baseRect.x + scanGeo.baseRect.width;
  assert.ok(rightEdge <= 0.70 * 1920 + 30 && rightEdge >= 0.70 * 1920, `expected tight endX hit edge near ${0.70 * 1920}, got ${rightEdge}`);
}

console.log('archivalSuite.verify: keyframes, imageStyling, paperBackgrounds, strikeRefute+sparse, ink-bleed/archival-line-wipe, 7-layer compound pack/expand, live/offline MCP sync, Module 1-4 extended contracts, text card bg + coordinate alignment, and scan-focus empty-label/endpoint bend OK');
