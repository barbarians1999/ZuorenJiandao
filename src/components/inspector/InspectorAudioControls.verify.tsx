import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { registerHooks } from 'node:module';
import type { TimelineItem } from '../../editor/types';

import type { InspectorPanelProps } from './InspectorTypes';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
} });
const { InspectorAudioControls } = await import('./InspectorAudioControls');


const noop = () => undefined;
const audio: TimelineItem = { id: 'a1', track: 'A1', kind: 'audio', name: 'speech', src: '/speech.wav', startFrame: 30, durationInFrames: 90 };
const video: TimelineItem = { ...audio, id: 'v1', track: 'V1', kind: 'video', src: '/video.mp4' };
function panel(selection: TimelineItem[], patch: Partial<InspectorPanelProps> = {}): InspectorPanelProps {
  return {
    templates: [], selectedItem: selection[0]!, selectedItems: selection, selectedIds: selection.map((item) => item.id),
    fps: 30, canvasWidth: 1920, canvasHeight: 1080, collapsed: false,
    onCollapsedChange: noop, onItemPropChange: noop, onItemVolumeChange: noop, onItemFadeChange: noop,
    onItemTransformChange: noop, onItemCropChange: noop, onItemFiltersChange: noop, onItemMaskChange: noop,
    onItemZoomChange: noop, onItemEffectsChange: noop, getPlayhead: () => 30, onSetReframeKeyframe: noop,
    onRemoveReframeKeyframe: noop, onSetItemKeyframe: noop, onRemoveItemKeyframe: noop, onResetItemKeyframes: noop,
    onSeek: noop, transition: null, onAddTransition: noop, onSetTransition: noop, onRemoveTransition: noop,
    playerRef: { current: null }, historyGesture: { begin: noop, end: noop },
    onNormalizeLoudness: noop, ...patch,
  };
}
const render = (selection: TimelineItem[], patch: Partial<InspectorPanelProps> = {}) => renderToStaticMarkup(
  <InspectorAudioControls item={selection[0]!} panel={panel(selection, patch)} playheadLocal={{ localFrame: 0, inRange: true }} />,
);
const normal = render([audio], {
  audioTracks: [{ id: 'A1', label: '口播轨道', config: { role: 'anchor' } }], onAudioTrackChange: noop,
});
assert.match(normal, /片段音量/);
assert.match(normal, /统一响度/);
assert.match(normal, /声音淡入淡出/);
assert.match(normal, /人声与配乐/);
assert.match(normal, /口播轨道/);
assert.match(normal, /作用于这个轨道的所有片段，不修改源文件/);
assert.match(normal, /更多音频处理/);
assert.doesNotMatch(normal, /自动闪避|响度归一/);

const mixed = render([audio, { ...audio, id: 'a2', volume: 0.5, fadeInFrames: 15 }]);
assert.match(mixed, /aria-label="音量"[^>]*disabled=""/);
assert.match(mixed, /aria-label="淡入"[^>]*disabled=""/);
assert.doesNotMatch(mixed, /更多音频处理/);
assert.match(mixed, /统一响度/);

const noCallbacks = render([audio], { onNormalizeLoudness: undefined,
  audioTracks: [{ id: 'A1', label: '口播轨道', config: {} }], onAudioTrackChange: undefined });
assert.doesNotMatch(noCallbacks, /统一响度|人声与配乐/);
const videoMarkup = render([video]);
assert.doesNotMatch(videoMarkup, /<span>声音淡入淡出<\/span>/);
assert.match(videoMarkup, /aria-label="音量"/);
assert.match(videoMarkup, /已有片段淡入淡出/);
assert.doesNotMatch(videoMarkup, />统一响度<\/button>/);
const mixedKinds = render([audio, video]);
assert.doesNotMatch(mixedKinds, /aria-label="淡入"/);
assert.match(mixedKinds, /aria-label="音量"/);
assert.doesNotMatch(mixedKinds, />统一响度<\/button>/);
const keyed = render([{ ...audio, keyframes: { volume: [{ frame: 0, value: 0.5 }] } }]);
assert.match(keyed, /统一响度/);
assert.doesNotMatch(keyed, /分析所选音频并调整基础音量/);
const multiTrack = render([audio, { ...audio, id: 'a2', track: 'A2' }], {
  audioTracks: [{ id: 'A1', label: '人声轨道', config: { role: 'anchor' } }, { id: 'A2', label: '背景配乐', config: { role: 'follower' } }],
  onAudioTrackChange: noop,
});
assert.equal((multiTrack.match(/<fieldset/g) ?? []).length, 2);
assert.match(multiTrack, /背景配乐/);
console.log('InspectorAudioControls.verify: clip/track scope, mixed selection, missing callbacks and existing fades passed');
