import assert from 'node:assert/strict';
import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TimelineState, TrackUpdate } from '../../editor/types';
import { reduce } from '../../editor/reduce';
import { compositionPlan } from '../../editor/compositionPlan';

import { SliderRow } from '../inspector/InspectorKeyframeControls';
import { TrackAudioControlView } from './TrackAudioControl';


type Props = Record<string, unknown>;
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = find(child, predicate);
      if (result) return result;
    }
    return undefined;
  }
  if (!isValidElement<Props>(node)) return undefined;
  return predicate(node.type, node.props) ? node.props : find(node.props.children as ReactNode, predicate);
}

const updates: TrackUpdate[] = [];
const roles: unknown[] = [];
const view = TrackAudioControlView({
  config: { role: 'follower', audioRouting: { gainDb: 3, duckDepthDb: -18 } },
  translate: (text) => text,
  onChange: (patch) => updates.push(patch),
  onRoleChosen: (role) => roles.push(role),
});
const buttons = (label: string) => {
  const result = find(view, (type, props) => type === 'button' && (() => {
    const contents = renderToStaticMarkup(props.children as ReactNode);
    return contents === label || contents.startsWith(`${label} ·`);
  })());
  assert.ok(result, label);
  return result;
};
(buttons('普通音频').onClick as () => void)();
(buttons('人声').onClick as () => void)();
(buttons('配乐压低').onClick as () => void)();
(buttons('常用').onClick as () => void)();
assert.deepEqual(updates, [
  { role: null }, { role: 'anchor' }, { role: 'follower' }, { audioRouting: { duckDepthDb: -12 } },
]);
assert.deepEqual(roles, [null, 'anchor', 'follower']);
const gain = find(view, (type, props) => type === SliderRow && props.label === '整轨音量');
assert.ok(gain);
(gain.onChange as (value: number) => void)(-9);
(gain.onReset as () => void)();
assert.deepEqual(updates.slice(-2), [{ audioRouting: { gainDb: -9 } }, { audioRouting: { gainDb: null } }]);
assert.equal(gain.val, 3);

const follower = renderToStaticMarkup(view);
assert.match(follower, /配乐压低多少/);
assert.match(follower, /aria-pressed="true" title="-18 dB"/);
assert.doesNotMatch(follower, /作用于这个轨道的所有片段/);
const ordinary = renderToStaticMarkup(<TrackAudioControlView config={{}} translate={(text) => text} onChange={() => undefined} />);
assert.doesNotMatch(ordinary, /配乐压低多少/);
assert.match(ordinary, /aria-pressed="true"/);
const anchor = renderToStaticMarkup(<TrackAudioControlView config={{ role: 'anchor' }} translate={(text) => text} onChange={() => undefined} />);
assert.doesNotMatch(anchor, /配乐压低多少/);
assert.doesNotMatch(follower, /font-size:1[0123]px/);
let state: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null, trackOrder: ['V1', 'A1', 'A2'],
  tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' }, A2: { kind: 'audio', audioRouting: { gainDb: 3 } } },
  items: [
    { id: 'speech', name: 'speech', track: 'A1', kind: 'audio', src: '/speech.wav', startFrame: 30, durationInFrames: 60 },
    { id: 'music', name: 'music', track: 'A2', kind: 'audio', src: '/music.wav', startFrame: 0, durationInFrames: 120 },
  ],
};
state = reduce(state, { type: 'track.update', track: 'A1', patch: { role: 'anchor' } });
state = reduce(state, { type: 'track.update', track: 'A2', patch: { role: 'follower' } });
state = reduce(state, { type: 'track.update', track: 'A2', patch: { audioRouting: { duckDepthDb: -18 } } });
assert.equal(state.tracks?.A2?.audioRouting?.gainDb, 3, 'changing duck depth keeps the existing track volume');
const plan = compositionPlan(state);
assert.ok(Math.abs(plan.gainAt('A2', 0) - 10 ** (3 / 20)) < 1e-10);
assert.ok(Math.abs(plan.gainAt('A2', 30) - 10 ** (-15 / 20)) < 1e-10);
assert.ok(Math.abs(plan.gainAt('A2', 90) - 10 ** (3 / 20)) < 1e-10, 'music recovers at the existing speech-clip boundary');
state = reduce(state, { type: 'track.update', track: 'A2', patch: { role: null } });
assert.ok(state.tracks?.A2, 'ordinary music track remains present after disabling ducking');
assert.equal(state.tracks.A2.role, undefined);
assert.equal(state.tracks.A2.audioRouting?.duckDepthDb, undefined);
assert.equal(state.tracks.A2.audioRouting?.gainDb, 3, 'disabling ducking keeps ordinary track volume');
console.log('TrackAudioControl.verify: unchanged role/gain/depth callbacks, clear labels and track scope passed');
