import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { PICTURE_ANIMATIONS } from '../../editor/clipAnimation';
import { TITLE_ANIMATIONS } from '../../editor/textStyles';
import type { TimelineItem } from '../../editor/types';
const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null } });
try {
const { PictureAnimationControl } = await server.ssrLoadModule('/src/components/inspector/PictureAnimationControl.tsx');
const item: TimelineItem = { id: 'video', kind: 'video', track: 'V1', startFrame: 0, durationInFrames: 60, name: 'video' };
const markup = (props = {}, mixed = false, kind: TimelineItem['kind'] = 'video') => renderToStaticMarkup(<PictureAnimationControl item={{ ...item, kind, props }} fps={30} mixed={() => mixed} onChange={() => undefined} />);
const plain = markup();
assert.equal((plain.match(/role="tab"/g) ?? []).length, 2, 'entrance and exit have dedicated tabs');
assert.doesNotMatch(plain, /<select/, 'animations apply through one-click cards');
assert.equal((plain.match(/type="number"[^>]*disabled/g) ?? []).length, 1, 'none disables irrelevant timing');
for (const { id } of PICTURE_ANIMATIONS) assert.match(plain, new RegExp(`data-motion="${id}"`));
const animated = markup({ visualEntrance: 'whip', visualExit: 'zoom', visualEntranceFrames: 15, visualExitFrames: 9 });
assert.match(animated, /aria-pressed="true"><span[^>]*data-motion="whip"/);
assert.match(animated, /value="0[.]5"/);
assert.match(animated, /已应用：甩入/);
assert.match(plain, /当前未添加动画/);
assert.doesNotMatch(plain, /自动试看/);
assert.doesNotMatch(plain, /试看入场|试看出场/);
assert.doesNotMatch(plain, /卡片仅为示意/);
assert.match(plain, /type="range"/);
assert.match(plain, /动画分类/);
assert.doesNotMatch(animated, /type="number"[^>]*disabled/);
assert.match(markup({}, true), /所选片段的动画不同/);
const titles = markup({ entrance: 'wipe' }, false, 'text');
for (const { id } of TITLE_ANIMATIONS) assert.match(titles, new RegExp(`data-motion="${id}"`));
assert.match(titles, /aria-pressed="true"><span[^>]*data-motion="wipe"/);
console.log('PictureAnimationControl.verify: independent tabs, one-click cards, seconds, mixed selection and title support passed');
} finally { await server.close(); }

