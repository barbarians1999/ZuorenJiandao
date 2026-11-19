import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewProxyStatus, PreviewSourceToggle } from './PreviewSourceControls';
import { setPreviewSourceMode } from '../../media/qualityPolicy';

setPreviewSourceMode('original');
let html = renderToStaticMarkup(<PreviewSourceToggle />);
assert.match(html, /aria-pressed="true"[^>]*>原片/);
assert.match(html, /<details/);
setPreviewSourceMode('proxy');
html = renderToStaticMarkup(<PreviewSourceToggle />);
assert.match(html, /aria-pressed="true"[^>]*>流畅/);
const proxies = [
  { src: '/a.mp4', proxy: { status: 'loading' as const, reason: 'preparing' } },
  { src: '/b.mp4', proxy: { status: 'ready' as const, reason: 'ready', previewSrc: '/b-proxy.mp4' } },
  { src: '/c.mp4', proxy: { status: 'failed' as const, reason: 'error', error: 'disk full' } },
];
html = renderToStaticMarkup(<PreviewProxyStatus proxies={proxies} />);
assert.match(html, /准备中 1/);
assert.match(html, /已就绪 1/);
assert.match(html, /失败 1/);
assert.match(html, /重试失败素材/);
assert.doesNotMatch(html, /\d+%/);
setPreviewSourceMode('original');
assert.equal(renderToStaticMarkup(<PreviewProxyStatus proxies={proxies} />), '');
console.log('PreviewSourceControls.verify: opt-in controls and honest status passed');
