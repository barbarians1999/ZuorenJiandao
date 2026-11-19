import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState } from '../../editor/types';


// This check verifies SSR control markup; visual layout is covered by the
// mounted Electron fixture, so Node only ignores the dialog CSS imports.
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
} });
const { TimelineToolbar } = await import('./TimelineToolbar');

const initial: TimelineState = { fps: 30, width: 1920, height: 1080, selectedId: null, items: [],
  tracks: { main: { kind: 'video' } }, trackOrder: ['main'] };
const noop = () => undefined;
const markup = (state: TimelineState, preview = true, zoom = 1, zoomMin = 0.02) => renderToStaticMarkup(<TimelineToolbar
  state={state} commands={{} as EditorCommands} editMode="selection" placeMode="insert" setPlaceMode={noop}
  snapping={true} hoverPreviewEnabled={preview} setHoverPreviewEnabled={noop}
  recorder={{ recording: false, error: null, toggle: noop }} canRecord={false} playing={false}
  timecodeRef={{ current: null }} playheadRef={{ current: 0 }} playheadFrame={0} total={0}
  captionsVisible={false} zoom={zoom} zoomMin={zoomMin} setZoom={noop}
/>);
const before = structuredClone(initial);
const plain = markup(initial);
assert.deepEqual(initial, before, 'rendering legacy timeline must not initialize or change interaction settings');
for (const label of ['主轨磁吸', '联动', '自动吸附', '预览轴']) assert.ok(plain.includes(`>${label}</span>`), label);
assert.match(plain, />智能分割镜头<\/span>/, 'scene splitting has a first-level toolbar entry');
assert.doesNotMatch(plain, />场景检测<\/button>/, 'no differently named duplicate in the more-tools menu');
assert.match(plain, /主轨磁吸：关/);
assert.match(plain, /联动：关/);
assert.match(plain, /预览轴：开/);
const checks = plain.match(/<input type="checkbox"[^>]*>/g) ?? [];
assert.equal(checks.length, 5);
const lowZoom = markup(initial, true, 0.0054, 0.0054);
const zoomSlider = lowZoom.match(/<input[^>]*class="cc-timeline-zoom"[^>]*>/)?.[0] ?? '';
assert.match(zoomSlider, /min="0\.0054"/);
assert.match(zoomSlider, /step="any"/);
assert.match(zoomSlider, /value="0\.0054"/, 'the slider retains small long-project zoom values');
assert.ok(checks.slice(0, 4).every((input) => input.includes('checked')));
assert.ok(!checks[4]!.includes('checked'), 'audio must not be selected by default');
const enabled = markup({ ...initial, interaction: { mainTrackId: 'main', magnet: true, linkage: true, linkedKinds: ['audio'] } }, false);
assert.match(enabled, /主轨磁吸：开/);
assert.match(enabled, /联动：开/);
assert.match(enabled, /预览轴：关/);
assert.equal((enabled.match(/<input type="checkbox"[^>]*checked/g) ?? []).length, 1);
assert.match(enabled, /开关不会自动绑定现有素材/);
assert.match(plain, /cc-timeline-more-menu/);
const toolbarSource = readFileSync(new URL('./TimelineToolbar.tsx', import.meta.url), 'utf8');
const moreMenuSource = toolbarSource.slice(toolbarSource.indexOf('function TimelineMoreControl'), toolbarSource.indexOf('const LINKED_KINDS'));
assert.doesNotMatch(moreMenuSource, /插入素材（后面顺延）|覆盖素材（替换重叠处）/,
  'insert/overwrite is shown once as the current mode, not duplicated in the overflow menu');
const controller = readFileSync(new URL('./useTimelineController.ts', import.meta.url), 'utf8');
assert.match(controller, /usePersistedState\('cc.hoverPreviewEnabled', true\)/);
assert.match(controller, /if \(!hoverPreviewEnabledRef.current\) \{ clearHoverPreview\(\); return; \}/);
const actions = readFileSync(new URL('../../shortcuts/useEditorActions.ts', import.meta.url), 'utf8');
assert.doesNotMatch(actions, /activeEditorState\(deps.docRef.current\)/, 'editing actions must use live transient selection');
assert.match(actions, /const state = deps.stateRef.current/);
console.log('TimelineToolbar.verify: distinct controls, persisted preview setting, legacy no-op render, directional linkage defaults, live selection wiring OK');
