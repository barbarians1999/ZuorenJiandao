import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaSourceRangePanel } from './MediaSourceRangePanel';
import { readFile } from 'node:fs/promises';

const props = { asset: { id: 'a', name: 'Long clip', kind: 'video' as const, src: '/original.mp4', durationInFrames: 36000 },
  fps: 30, range: { srcInFrame: 300, durationInFrames: 150 }, onChange: () => undefined, onAdd: () => undefined, onClose: () => undefined };
const html = renderToStaticMarkup(<MediaSourceRangePanel {...props} />);
assert.match(html, /src="\/original.mp4"/);
assert.match(html, /设为入点 I/);
assert.match(html, /设为出点 O/);
assert.match(html, /aria-label="入点"/);
assert.match(html, /aria-label="出点"/);
assert.match(html, /已选 5.000 秒/);
assert.match(html, /第 301–450 帧/);
assert.match(html, /draggable="true"/);
assert.match(html, /加入选段/);
assert.match(html, /恢复整段/);
assert.match(renderToStaticMarkup(<MediaSourceRangePanel {...props} asset={{ ...props.asset, kind: 'audio' }} />), /音频选段/);
const [panel, grid, source] = await Promise.all([
  readFile(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./MediaPoolGrid.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./MediaSourceRangePanel.tsx', import.meta.url), 'utf8'),
]);
assert.match(panel, /asset\.sourceRevision, asset\.durationInFrames, fps/, 'range identity expires on relink, source duration or FPS change');
assert.match(grid, /active=\{!props\.sourcePreviewOpen/, 'source monitor suppresses card hover playback');
assert.match(source, /removeAttribute\('src'\)/, 'closing the monitor releases its media decoder');
assert.match(source, /event\.stopPropagation\(\)/, 'I/O and space do not reach timeline shortcuts');
const css = await readFile(new URL('./mediaSourceRange.css', import.meta.url), 'utf8');
assert.ok([...css.matchAll(/font-size:\s*(\d+)px/g)].every((match) => Number(match[1]) >= 14),
  'source range controls and metadata must remain readable');
console.log('MediaSourceRangePanel.verify: SSR controls and bounded source-player wiring passed (not browser playback acceptance)');
