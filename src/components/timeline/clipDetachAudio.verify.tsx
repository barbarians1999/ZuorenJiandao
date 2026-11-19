import assert from 'node:assert/strict';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { historyReduce, type History } from '../../editor/reduce';
import { docFromTimeline } from '../../persist/projectStore';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState } from '../../editor/types';

const state: TimelineState = { fps: 30, width: 640, height: 360, selectedId: 'first', selectedIds: ['first', 'second'],
  trackOrder: ['V1', 'A1'], tracks: { V1: { kind: 'video' }, A1: { kind: 'audio' } }, items: [
    { id: 'first', kind: 'video', name: 'First', track: 'V1', src: '/clip.mp4', startFrame: 0, durationInFrames: 30, volume: .7 },
    { id: 'second', kind: 'video', name: 'Second', track: 'V1', src: '/clip.mp4', startFrame: 30, srcInFrame: 30, durationInFrames: 30, volume: .8 },
  ] };
const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null } });
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1200, innerHeight: 800 } });
try {
  const { ClipContextMenu } = await server.ssrLoadModule('/src/components/timeline/ClipContextMenu.tsx');
  const initial = docFromTimeline(state);
  let history: History = { past: [], present: initial, future: [] };
  let commits = 0, closes = 0;
  const commands = { applyState: (next: TimelineState) => {
    commits++;
    history = historyReduce(history, { type: 'setFullState', state: next });
  } } as unknown as EditorCommands;
  const noop = () => undefined;
  function findAction(node: ReactNode): { label: string; title?: string; disabled?: boolean; onClick: () => void } | undefined {
    if (Array.isArray(node)) return node.map(findAction).find(Boolean);
    if (!isValidElement<{ label?: string; disabled?: boolean; onClick?: () => void; children?: ReactNode }>(node)) return;
    if (node.props.label?.startsWith('分离音频')) return node.props as { label: string; disabled?: boolean; onClick: () => void };
    return findAction(node.props.children);
  }
  // SSR supplies the real hook dispatcher; invoke the actual menu callback, not a copied action.
  function Probe() {
    const menu = ClipContextMenu({ item: state.items[0], timeline: state, selectedIds: state.selectedIds,
      transitions: [], x: 10, y: 10, playhead: 0, commands, fxClip: null, onCopyFx: noop,
      onClose: () => { closes++; }, onExportMg: noop, onConvertToVideo: noop, onAddComment: noop,
      onRelinkFile: noop, onDetectScenes: noop });
    const action = findAction(menu);
    assert(action && !action.disabled, 'Selected videos must expose an enabled detach action');
    action.onClick();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  const timeline = history.present.timelines[0]!;
  assert.equal(timeline.items.filter(item => item.kind === 'audio').length, 2, 'One menu click must detach both selected videos');
  assert(timeline.items.filter(item => item.kind === 'video').every(item => item.volume === 0 && item.audioDetached));
  assert.equal(commits, 1); assert.equal(closes, 1); assert.equal(history.past.length, 1);
  const undone = historyReduce(history, { type: 'undo' }); assert.deepEqual(undone.present, initial);
  assert.equal(historyReduce(undone, { type: 'redo' }).present.timelines[0]!.items.filter(item=>item.kind==='audio').length, 2);
  function actionFor(timelineState: TimelineState, clicked: string, selectedIds: string[]) {
    let action: ReturnType<typeof findAction>;
    function MenuProbe() {
      action = findAction(ClipContextMenu({ item: timelineState.items.find(item=>item.id===clicked)!, timeline: timelineState, selectedIds,
        transitions: [], x: 10, y: 10, playhead: 0, commands, fxClip: null, onCopyFx: noop, onClose: noop,
        onExportMg: noop, onConvertToVideo: noop, onAddComment: noop, onRelinkFile: noop, onDetectScenes: noop }));
      return null;
    }
    renderToStaticMarkup(createElement(MenuProbe));
    return action;
  }
  assert.match(actionFor(state,'first',['first','second'])!.label,/2/);
  const partiallyDetached={...state,items:state.items.map(item=>item.id==='first'?{...item,audioDetached:true}:item)};
  assert.equal(actionFor(partiallyDetached,'first',['first','second'])!.disabled,false,
    'Right-clicking an already detached selected clip must still act on the other selected videos');
  const blocked:TimelineState={...state,transitions:[{id:'audio-transition',type:'audio-cross-fade',trackId:'V1',outgoingItemId:'second',incomingItemId:'other',durationInFrames:5}]};
  const disabled=actionFor(blocked,'first',['first','second'])!;
  assert.equal(disabled.disabled,true);assert.match(disabled.title!,/转场/);
  const withAudio:TimelineState={...state,items:[...state.items,{id:'music',name:'Music',kind:'audio',track:'A1',src:'/music.mp3',startFrame:90,durationInFrames:30}]};
  assert.match(actionFor(withAudio,'music',['first','second','music'])!.label,/2/,
    'Mixed selection exposes the same batch action when right-clicking selected audio');
  const outside={...state,items:[...state.items,{...state.items[0]!,id:'third',startFrame:60}]};
  assert.equal(actionFor(outside,'third',['first','second'])!.label,'分离音频',
    'Right-clicking outside the selection only targets the clicked video');
  console.log('clipDetachAudio.verify: actual multi-selection menu callback, both videos, one undo and redo passed');
} finally {
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  await server.close();
}
