import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { addClipMosaic, setMosaicMode, updateClipMosaicById } from '../../editor/mosaic';
import type { TimelineItem } from '../../editor/types';

const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null } });
try {
const { MosaicControl } = await server.ssrLoadModule('/src/components/inspector/MosaicControl.tsx');
const { MaskControl } = await server.ssrLoadModule('/src/components/inspector/InspectorVisualControls.tsx');
const { InspectorContent } = await server.ssrLoadModule('/src/components/inspector/InspectorContent.tsx');
const noop = () => undefined;
const item: TimelineItem = { id: 'a', kind: 'video', track: 'V1', name: 'a', startFrame: 0, durationInFrames: 60 };
const blur = renderToStaticMarkup(<MosaicControl item={{ ...item, effects: setMosaicMode([], 'local', 'blur') }} onChange={noop} />);
assert(blur.includes('马赛克范围'));
assert(!blur.includes('请确认敏感内容已看不清'));
assert(blur.includes('模糊强度'));
assert(!blur.includes('颗粒大小'));
assert(blur.includes('局部打码') && blur.includes('全屏打码'));
assert(blur.includes('边缘羽化'));
assert(blur.includes('马赛克 1') && blur.includes('＋ 添加马赛克'));
assert(blur.includes('高斯模糊') && blur.includes('像素马赛克'));

// Multi-mosaic selection renders chips for 马赛克 1 and 马赛克 2 and switches properties below
let twoMosaics = addClipMosaic([], 'm1');
twoMosaics = addClipMosaic(twoMosaics, 'm2');
twoMosaics = updateClipMosaicById(twoMosaics, 'm2', { style: 'pixel', blockSize: 33 });
const selectedSecond = renderToStaticMarkup(
  <MosaicControl item={{ ...item, effects: twoMosaics }} selectedEffectId="m2" onChange={noop} />,
);
assert(selectedSecond.includes('马赛克 1') && selectedSecond.includes('马赛克 2'));
assert(selectedSecond.includes('块大小') && selectedSecond.includes('33'));

// Video item InspectorContent must unify mosaic & effects under 特效 tab and remove the separate 马赛克 tab
const inspectorMarkup = renderToStaticMarkup(
  <InspectorContent
    item={{ ...item, effects: twoMosaics }}
    schema={[]}
    playheadLocal={{ localFrame: 0, inRange: true }}
    activeTab="effects"
    onTabChange={noop}
    panel={{
      templates: [],
      selectedItem: { ...item, effects: twoMosaics },
      selectedIds: ['a'],
      selectedItems: [{ ...item, effects: twoMosaics }],
      fps: 30,
      canvasWidth: 640,
      canvasHeight: 360,
      collapsed: false,
      onCollapsedChange: noop,
      onItemPropChange: noop,
      onItemVolumeChange: noop,
      onItemFadeChange: noop,
      onItemTransformChange: noop,
      onItemCropChange: noop,
      onItemFiltersChange: noop,
      onItemMaskChange: noop,
      onItemZoomChange: noop,
      onItemEffectsChange: noop,
      selectedMosaicEffectId: 'm2',
      onSelectMosaicEffect: noop,
      getPlayhead: () => 0,
      onSetReframeKeyframe: noop,
      onRemoveReframeKeyframe: noop,
      onSetItemKeyframe: noop,
      onRemoveItemKeyframe: noop,
      onResetItemKeyframes: noop,
      onSeek: noop,
      transition: null,
      onAddTransition: noop,
      onSetTransition: noop,
      onRemoveTransition: noop,
      playerRef: { current: null },
      historyGesture: { begin: noop, end: noop },
    }}
  />,
);
assert(inspectorMarkup.includes('role="tab"') && inspectorMarkup.includes('>画面<') && inspectorMarkup.includes('>特效<'));
assert(!inspectorMarkup.includes('画面 / 文字'), '视频片段属性页不得再显示合并的 画面 / 文字 标签');
assert(!inspectorMarkup.includes('>马赛克</button>'), '视频片段属性页不得再出现独立的马赛克标签页');
assert(inspectorMarkup.includes('马赛克 2') && inspectorMarkup.includes('画面特效与 LUT'));
assert(!inspectorMarkup.includes('尚未添加特效。') || !inspectorMarkup.includes('1. 高斯模糊'), '马赛克不得在下方 EffectsControl 重复列出');

const textItem: TimelineItem = { id: 't1', kind: 'text', track: 'T1', name: 't1', startFrame: 0, durationInFrames: 60 };
const basePanel = {
  templates: [],
  selectedIds: ['t1'],
  selectedItems: [textItem],
  fps: 30,
  canvasWidth: 640,
  canvasHeight: 360,
  collapsed: false,
  onCollapsedChange: noop,
  onItemPropChange: noop,
  onItemVolumeChange: noop,
  onItemFadeChange: noop,
  onItemTransformChange: noop,
  onItemCropChange: noop,
  onItemFiltersChange: noop,
  onItemMaskChange: noop,
  onItemZoomChange: noop,
  onItemEffectsChange: noop,
  getPlayhead: () => 0,
  onSetReframeKeyframe: noop,
  onRemoveReframeKeyframe: noop,
  onSetItemKeyframe: noop,
  onRemoveItemKeyframe: noop,
  onResetItemKeyframes: noop,
  onSeek: noop,
  transition: null,
  onAddTransition: noop,
  onSetTransition: noop,
  onRemoveTransition: noop,
  playerRef: { current: null },
  historyGesture: { begin: noop, end: noop },
};
const textInspectorMarkup = renderToStaticMarkup(
  <InspectorContent
    item={textItem}
    schema={[]}
    playheadLocal={{ localFrame: 0, inRange: true }}
    activeTab="basic"
    onTabChange={noop}
    panel={{ ...basePanel, selectedItem: textItem }}
  />,
);
assert(textInspectorMarkup.includes('>文字<'), '纯文字片段属性页应显示 文字 标签');
assert(!textInspectorMarkup.includes('>画面<') && !textInspectorMarkup.includes('画面 / 文字'), '纯文字片段属性页不得显示 画面 或 画面 / 文字');

const mixedInspectorMarkup = renderToStaticMarkup(
  <InspectorContent
    item={item}
    schema={[]}
    playheadLocal={{ localFrame: 0, inRange: true }}
    activeTab="basic"
    onTabChange={noop}
    panel={{
      ...basePanel,
      selectedItem: item,
      selectedIds: ['a', 't1'],
      selectedItems: [item, textItem],
    }}
  />,
);
assert(mixedInspectorMarkup.includes('>画面<'), '混合选中视频和文字片段时应显示 画面 标签');
assert(!mixedInspectorMarkup.includes('画面 / 文字'), '混合选中时不得再显示 画面 / 文字');

const mask = renderToStaticMarkup(<MaskControl item={{ ...item, mask: { type: 'ellipse', x: .2, y: .2, width: .6, height: .6 } }}
  onChange={noop} onReset={noop} kf={{ localFrame: 0, inRange: true, set: noop, remove: noop, seekLocal: noop }} />);
assert(mask.includes('矩形') && mask.includes('椭圆'));
assert(mask.includes('cc-insp-control-line') && mask.includes('cc-insp-kf') && mask.includes('左侧') && mask.includes('羽化'));
const css = readFileSync('src/components/inspector/clip-region-controls.css', 'utf8');
assert(css.includes('font-size:14px'));
assert(css.includes('min-height:76px'));
assert(css.includes('min-height:36px'));
console.log('MosaicControl.verify: Gaussian, multi-mosaic, unified Effects tab, and mask controls passed');
} finally { await server.close(); }

