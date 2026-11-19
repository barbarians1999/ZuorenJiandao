import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PlayerRef } from '@remotion/player';
import { PreviewWorkspace } from '../../src/components/preview/PreviewWorkspace';
import type { InspectorPanelProps } from '../../src/components/inspector/InspectorTypes';
import { useEditor } from '../../src/editor/store';
import { docFromTimeline, migrateProjectDoc } from '../../src/persist/projectStore';
import { initSkins, applySkin } from '../../src/skins';
import { appearanceAt } from '../../src/editor/clipFade';
import '../../src/index.css';

initSkins(); applySkin('constructivist');
const noop = () => undefined;
const storageKey = 'qa.mask-drag';
const initial = docFromTimeline({ fps: 30, width: 640, height: 360, selectedId: 'video', selectedIds: ['video'],
  trackOrder: ['V1'], tracks: { V1: { kind: 'video' } }, items: [{ id: 'video', track: 'V1', kind: 'video',
    name: 'Mask drag generated fixture', src: '/media/uploads/jianying-fixture.mp4', width: 640, height: 360,
    startFrame: 0, durationInFrames: 90, volume: 0 }] });
const load = () => { try { return migrateProjectDoc(JSON.parse(sessionStorage.getItem(storageKey) ?? 'null')) ?? initial; } catch { return initial; } };
const qa = { doc: initial, frame: 0, ready: false, beginCount: 0, endCount: 0,
  save: () => initial, appearance: () => ({} as ReturnType<typeof appearanceAt>),
  state: () => initial.timelines[0]!, cancelBySelection: noop, lock: noop, unlock: noop };
(window as unknown as { maskDragQA: typeof qa }).maskDragQA = qa;
function Harness() {
  const { state, doc, commands, canUndo, canRedo } = useEditor(load());
  const playerRef = useRef<PlayerRef | null>(null);
  const [frame, setFrame] = useState(0);
  const item = state.items.find((v) => v.id === state.selectedId) ?? null;
  const begin = () => { qa.beginCount++; commands.beginHistoryGesture(); };
  const end = () => { qa.endCount++; commands.endHistoryGesture(); };
  qa.doc = doc; qa.frame = frame; qa.ready = true;
  qa.state = () => state;
  qa.save = () => { sessionStorage.setItem(storageKey, JSON.stringify(doc)); return doc; };
  qa.appearance = () => appearanceAt(state.items[0]!, frame, false, state);
  qa.cancelBySelection = () => commands.selectItem(null);
  qa.lock = () => commands.updateTrack(state.items[0]!.track, { locked: true });
  qa.unlock = () => commands.updateTrack(state.items[0]!.track, { locked: false });
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const listener = ({ detail }: { detail: { frame: number } }) => setFrame(detail.frame);
    player.addEventListener('frameupdate', listener);
    return () => player.removeEventListener('frameupdate', listener);
  }, []);
  const panel: InspectorPanelProps = {
    selectedItem: item, selectedItems: item ? [item] : [], selectedIds: item ? [item.id] : [], templates: [],
    fps: 30, canvasWidth: 640, canvasHeight: 360, collapsed: false, onCollapsedChange: noop,
    onItemMaskChange: (mask) => { if (item) commands.setItemMask(item.id, mask); },
    onItemTransformChange: (patch) => { if (item) commands.setItemTransform(item.id, patch); },
    onItemPropChange: noop, onItemVolumeChange: noop, onItemFadeChange: noop, onItemCropChange: noop,
    onItemFiltersChange: noop, onItemZoomChange: noop,
    onItemEffectsChange: (effects) => { if (item) commands.setItemEffects(item.id, effects); },
    onSetItemKeyframe: (prop, at, value, easing) => { if (item) commands.setItemKeyframe(item.id, prop, at, value, easing); },
    onRemoveItemKeyframe: (prop, at) => { if (item) commands.removeItemKeyframe(item.id, prop, at); },
    onResetItemKeyframes: noop, onSetReframeKeyframe: noop, onRemoveReframeKeyframe: noop,
    onSeek: (at) => playerRef.current?.seekTo(at), getPlayhead: () => playerRef.current?.getCurrentFrame() ?? 0,
    transition: null, onAddTransition: noop, onSetTransition: noop, onRemoveTransition: noop, playerRef,
    historyGesture: { begin, end },
  };
  return <main style={{ color: 'var(--cc-text)', background: 'var(--cc-bg)', fontSize: 15, padding: 24 }}>
    <h1 style={{ fontSize: 22 }}>蒙版：预览画面直接操作验收</h1>
    <div style={{ display: 'flex', gap: 12, margin: '16px 0' }}>
      <button onClick={() => { sessionStorage.removeItem(storageKey); commands.applyDoc(initial); playerRef.current?.seekTo(0); }}>重置工程</button>
      <button onClick={() => commands.selectItem('video')}>选择视频</button>
      <button onClick={() => commands.selectItem(null)}>取消选中</button>
      <button onClick={commands.undo} disabled={!canUndo}>撤销</button><button onClick={commands.redo} disabled={!canRedo}>重做</button>
      <button onClick={qa.save}>保存工程</button>
      <button onClick={() => playerRef.current?.seekTo(45)}>跳转45帧</button>
      <button onClick={() => commands.setItemTransform('video', { x: 5, y: -3, scaleX: .8, scaleY: .7, rotation: 25, crop: { left: .05, top: .03 } })}>变换测试</button>
    </div>
    <div id="actual-preview" className="cc-editor-preview-column" style={{ width: 1300, height: 760 }}>
      <PreviewWorkspace inspector={item ? panel : null} preview={{ state, project: doc, playerRef, onImport: async () => {},
        projectId: 'qa-mask-drag', timelineId: doc.activeTimelineId, reviewState: state, selectedItem: item,
        inspectorOpen: !!item, onToggleInspector: noop, onSelectItem: commands.selectItem,
        onSetItemTransform: commands.setItemTransform, onSetItemKeyframe: commands.setItemKeyframe,
        onRemoveItemKeyframe: commands.removeItemKeyframe, onSeek: (at) => playerRef.current?.seekTo(at),
        onBeginHistoryGesture: begin, onEndHistoryGesture: end }} />
    </div><p>帧：{frame}</p>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);

