import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewProxyStatus, PreviewSourceToggle } from './PreviewSourceControls';
import { setPreviewSourceMode } from '../../media/qualityPolicy';

setPreviewSourceMode('original');
let html = renderToStaticMarkup(<PreviewSourceToggle />);
assert.match(html, /aria-label="预览画质"/);
assert.match(html, /画质：原片/);
assert.match(html, /<option value="original" selected=""/);
setPreviewSourceMode('proxy');
html = renderToStaticMarkup(<PreviewSourceToggle />);
assert.match(html, /画质：流畅/);
assert.match(html, /<option value="proxy" selected=""/);
setPreviewSourceMode('auto');
html = renderToStaticMarkup(<PreviewSourceToggle />);
assert.match(html, /画质：自动/);
const proxies = [
  { src: '/a.mp4', proxy: { status: 'loading' as const, reason: 'preparing' } },
  { src: '/b.mp4', proxy: { status: 'ready' as const, reason: 'ready', previewSrc: '/b-proxy.mp4' } },
  { src: '/c.mp4', proxy: { status: 'failed' as const, reason: 'error', error: 'disk full' } },
];
html = renderToStaticMarkup(<PreviewProxyStatus proxies={proxies} />);
assert.match(html, /准备 1/);
assert.match(html, /就绪 1/);
assert.match(html, /失败 1/);
assert.match(html, /重试/);
assert.doesNotMatch(html, /\d+%/);
setPreviewSourceMode('original');
assert.equal(renderToStaticMarkup(<PreviewProxyStatus proxies={proxies} />), '');
console.log('PreviewSourceControls.verify: compact selector and honest status passed');
