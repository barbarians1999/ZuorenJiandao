import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlayerRef } from '@remotion/player';
import type { RefObject } from 'react';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { t } from '../../i18n/locale';
import { PreviewTransformOverlay } from './PreviewTransformOverlay';
import { fitPreviewCanvasSize, previewPaddedClientSize, previewStageContentSize } from './previewCanvasGeometry';

const item: TimelineItem = {
  id: 'card',
  track: 'V2',
  startFrame: 0,
  durationInFrames: 90,
  kind: 'motion-graphic',
  name: '金句卡片',
  width: 1080,
  height: 1920,
  transform: { x: 5, y: -4, scale: 0.8, rotation: 8 },
};

const stateOf = (trackPatch: Record<string, unknown> = {}, selectedId: string | null = 'card'): TimelineState => ({
  fps: 30,
  width: 1080,
  height: 1920,
  fit: 'contain',
  selectedId,
  selectedIds: selectedId ? [selectedId] : [],
  trackOrder: ['V2'],
  tracks: { V2: { kind: 'video', ...trackPatch } },
  items: [item],
});

const playerRef = {
  current: { getCurrentFrame: () => 20, pause: () => undefined } as unknown as PlayerRef,
} as RefObject<PlayerRef | null>;

const props = {
  playerRef,
  onSelectItem: () => undefined,
  onSetItemTransform: () => undefined,
  onSetItemKeyframe: () => undefined,
  onRemoveItemKeyframe: () => undefined,
  onSeek: () => undefined,
  onBeginHistoryGesture: () => undefined,
  onEndHistoryGesture: () => undefined,
};

// The canvas wrapper itself must be the contained composition rect. All
// interactive overlays are inset:0 children of this wrapper, so keeping its
// aspect is what makes caption hit boxes and clip handles share one coordinate
// space after an aspect switch.
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 558, height: 770 },
    { width: 1920, height: 1080 },
  ),
  { width: 558, height: 313.875 },
  '16:9 应在竖向较高的预览栏中按宽度 contain，且宽高共用同一 scale',
);
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 558, height: 770 },
    { width: 1080, height: 1080 },
  ),
  { width: 558, height: 558 },
  '1:1 应得到正方形命中层与编辑框',
);
assert.deepEqual(
  fitPreviewCanvasSize(
    { width: 900, height: 500 },
    { width: 1080, height: 1920 },
  ),
  { width: 281.25, height: 500 },
  '9:16 应在横向较宽的预览栏中按高度 contain，不能把 281.25 收成 281',
);
{
  const fitted = fitPreviewCanvasSize({ width: 360, height: 776 }, { width: 1080, height: 1920 });
  assert.equal(fitted.width * 1920, fitted.height * 1080, 'preview wrapper aspect must equal the composition');
  assert.deepEqual(fitted, { width: 360, height: 640 });
}
assert.deepEqual(
  previewStageContentSize({
    contentBoxSize: [{ inlineSize: 360, blockSize: 776 }],
    contentRect: { width: 360, height: 776 },
  }),
  { width: 360, height: 776 },
  'stage size is the content box, not clientWidth with padding',
);
assert.deepEqual(
  previewPaddedClientSize(
    { width: 400, height: 800 },
    { left: 20, right: 20, top: 12, bottom: 12 },
  ),
  { width: 360, height: 776 },
  '12px 20px stage padding must not be treated as composition space',
);
const previewPanelSource = readFileSync(new URL('../PreviewPanel.tsx', import.meta.url), 'utf8');
assert.match(
  previewPanelSource,
  /fitPreviewCanvasSize\(stageSize,\s*\{\s*width:\s*state\.width,\s*height:\s*state\.height/s,
  '预览面板必须把 contain 后的同一画布尺寸交给播放器、字幕命中层和片段变换层',
);
assert.match(
  previewPanelSource,
  /previewStageContentSize/,
  'ResizeObserver must use the stage content box so padding is not composition space',
);
assert.match(
  previewPanelSource,
  /previewPaddedClientSize/,
  'first layout must subtract stage padding from clientWidth',
);

// A selected editable clip exposes one compact transform frame and nine handles.
{
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={stateOf()} {...props} />);
  assert.ok(markup.includes(`aria-label="${t('预览画布片段变换')}"`));
  assert.match(markup, /data-preview-selection="card"/);
  assert.equal((markup.match(/data-preview-handle="scale-[0-3]"/g) ?? []).length, 4, '四个角都应可等比缩放');
  assert.equal((markup.match(/data-preview-handle="crop-[nsew]"/g) ?? []).length, 4, '四边中点应可裁切遮盖');
  assert.equal((markup.match(/data-preview-handle="rotate"/g) ?? []).length, 1, '顶部应有一个旋转手柄');
  assert.match(markup, /var\(--cc-accent\)/, '控制框颜色跟随当前皮肤强调色');
  assert.match(markup, /在播放头添加位置关键帧/, '没有路径节点时仍显示可发现的添加按钮');
  assert.match(markup, /data-motion-path-interactive/, '运动路径控件必须与对象拖动事件隔离');
}

// Locked and hidden tracks can never expose writable controls.
for (const trackPatch of [{ locked: true }, { hidden: true }]) {
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={stateOf(trackPatch)} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
  assert.doesNotMatch(markup, /data-preview-handle=/);
}

// A timeline selection outside the current frame must not leave a stale box.
{
  const state = stateOf();
  state.items = [{ ...item, startFrame: 30 }];
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={state} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
}

// Window resize can briefly report a zero-size composition; controls stay hidden until geometry is valid.
{
  const state = stateOf();
  state.width = 0;
  state.height = 0;
  const markup = renderToStaticMarkup(<PreviewTransformOverlay state={state} {...props} />);
  assert.doesNotMatch(markup, /data-preview-selection=/);
  assert.doesNotMatch(markup, /data-preview-handle=/);
}

// Elliptical solid mask and mosaic item render dashed ellipse guide inside SVG without full-screen fallback.
{
  const shapeItem: TimelineItem = {
    id: 'ellipse-shape',
    track: 'V2',
    startFrame: 0,
    durationInFrames: 90,
    kind: 'solid',
    name: '椭圆形状',
    props: { color: '#ff0000' },
    mask: { type: 'ellipse', x: 0.25, y: 0.3, width: 0.5, height: 0.3, feather: 0 },
  };
  const shapeState: TimelineState = {
    ...stateOf(),
    selectedId: 'ellipse-shape',
    selectedIds: ['ellipse-shape'],
    items: [shapeItem],
  };
  const shapeMarkup = renderToStaticMarkup(<PreviewTransformOverlay state={shapeState} {...props} />);
  assert.match(shapeMarkup, /data-preview-ellipse="ellipse-shape"/, '椭圆形状应在预览选框中显示椭圆虚线轮廓');

  const workspaceSource = readFileSync(new URL('./PreviewWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(
    workspaceSource,
    /const isMosaicItem = inspector\?\.selectedItem\?\.kind === 'mosaic'/,
    '选中独立马赛克片段时，PreviewWorkspace 不得切入不支持的逐片段滤镜遮罩/马赛克编辑模式',
  );
  assert.match(workspaceSource, /!isMosaicItem && activeTab === 'mosaic'/);
}

// Selected mosaic elevates its hit region above unselected caption hitboxes, while yielding when a caption is active or when an untransformed bottom-track video is selected.
{
  const mosaicItem: TimelineItem = {
    id: 'mosaic-overlap',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
    kind: 'mosaic',
    name: '独立马赛克',
    mosaic: { shape: 'rectangle', centerX: 0.5, centerY: 0.85, width: 0.3, height: 0.14, strength: 60, feather: 0, opacity: 1 },
  };
  const mosaicState: TimelineState = {
    ...stateOf(),
    width: 1920,
    height: 1080,
    trackOrder: ['V1'],
    tracks: { V1: { kind: 'video' } },
    selectedId: 'mosaic-overlap',
    selectedIds: ['mosaic-overlap'],
    items: [mosaicItem],
  };
  const mosaicMarkup = renderToStaticMarkup(<PreviewTransformOverlay state={mosaicState} {...props} />);
  assert.match(mosaicMarkup, /data-preview-selected-hit="mosaic-overlap"/, '选中马赛克时必须渲染高优先级命中区域');
  assert.match(mosaicMarkup, /z-index:5/, '选中马赛克命中框与手柄必须高于未选中字幕命中层(z-index:4)');

  const yieldedMarkup = renderToStaticMarkup(<PreviewTransformOverlay state={mosaicState} captionActive {...props} />);
  assert.doesNotMatch(yieldedMarkup, /data-preview-selected-hit=/, '正在编辑字幕时不应抢占字幕命中区');

  const baseVideo: TimelineItem = {
    id: 'base-video',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
    kind: 'video',
    name: '底片',
    src: '/media/base.mp4',
    width: 1920,
    height: 1080,
  };
  const baseMarkup = renderToStaticMarkup(
    <PreviewTransformOverlay state={{ ...mosaicState, selectedId: 'base-video', selectedIds: ['base-video'], items: [baseVideo] }} {...props} />,
  );
  assert.doesNotMatch(baseMarkup, /data-preview-selected-hit=/, '底轨未变换主视频不得遮挡字幕命中区');
}

console.log('preview-transform-overlay.verify: ok (语义/皮肤/四角/四边裁切/旋转/锁定隐藏/帧范围)');
