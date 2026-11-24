import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { setMosaicMode } from '../../editor/mosaic';
import type { TimelineItem } from '../../editor/types';

const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null } });
try {
const { MosaicControl } = await server.ssrLoadModule('/src/components/inspector/MosaicControl.tsx');
const { MaskControl } = await server.ssrLoadModule('/src/components/inspector/InspectorVisualControls.tsx');
const noop = () => undefined;
const item: TimelineItem = { id: 'a', kind: 'video', track: 'V1', name: 'a', startFrame: 0, durationInFrames: 60 };
const blur = renderToStaticMarkup(<MosaicControl item={{ ...item, effects: setMosaicMode([], 'local', 'blur') }} onChange={noop} />);
assert(blur.includes('马赛克范围'));
assert(!blur.includes('请确认敏感内容已看不清'));
assert(blur.includes('模糊强度'));
assert(!blur.includes('颗粒大小'));
assert(blur.includes('局部打码') && blur.includes('全屏打码'));
assert(blur.includes('边缘羽化'));
const mask = renderToStaticMarkup(<MaskControl item={{ ...item, mask: { type: 'ellipse', x: .2, y: .2, width: .6, height: .6 } }}
  onChange={noop} onReset={noop} kf={{ localFrame: 0, inRange: true, set: noop, remove: noop, seekLocal: noop }} />);
assert(mask.includes('矩形') && mask.includes('椭圆'));
assert(mask.includes('cc-insp-control-line') && mask.includes('cc-insp-kf') && mask.includes('左侧') && mask.includes('羽化'));
const css = readFileSync('src/components/inspector/clip-region-controls.css', 'utf8');
assert(css.includes('font-size:14px'));
assert(css.includes('min-height:76px'));
assert(css.includes('min-height:36px'));
console.log('MosaicControl.verify: Gaussian and mask controls, labels, keyframes and accessible sizing passed');
} finally { await server.close(); }

