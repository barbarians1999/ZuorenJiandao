import assert from 'node:assert/strict';
import { formatExportDiagnostics } from './exportDiagnostics';

const t = (zh: string, params?: Record<string, string | number>) =>
  params ? Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), zh) : zh;

const hybrid = formatExportDiagnostics(
  {
    route: 'hybrid',
    timingsMs: { total: 45_200, plates: 8_400, encode: 31_000, audio: 3_200, mux: 2_600 },
    workers: 2,
    concurrencyFallback: true,
    plateCount: 120,
    totalFrames: 3600,
  },
  { id: 'h264_amf', label: 'AMD AMF', hardware: true, transport: 'server', renderRoute: 'hybrid' },
  t,
);

assert.ok(hybrid);
assert.match(hybrid.summary, /路线：高速混合导出/);
assert.match(hybrid.summary, /硬件编码 \(AMD AMF\)/);
assert.match(hybrid.summary, /耗时 45秒/);
assert.ok(hybrid.details.some((d) => d.includes('叠加贴图：8秒')));
assert.ok(hybrid.details.some((d) => d.includes('视频编码：31秒')));
assert.ok(hybrid.details.some((d) => d.includes('已自动降载防显存不足')));

const fallback = formatExportDiagnostics(
  {
    route: 'remotion',
    fallbackReasons: { directCut: 'overlays-or-transitions', hybrid: 'transitions' },
    timingsMs: { total: 130_000 },
  },
  { id: 'libx264', label: 'Software (libx264)', hardware: false, transport: 'server' },
  t,
);

assert.ok(fallback);
assert.match(fallback.summary, /完整逐帧渲染（因含特殊转场效果未走高速通道）/);
assert.match(fallback.summary, /耗时 2分10秒/);

assert.equal(formatExportDiagnostics(null, null, t), null);
console.log('exportDiagnostics.verify: passed');
