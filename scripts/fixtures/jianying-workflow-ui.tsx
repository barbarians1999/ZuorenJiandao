// Production components and selection store; only optional ASR is simulated.
// The real Electron font bridge is preserved. This fixture is not ASR accuracy QA.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '../../src/editor/TimelineComposition';
import { Timeline } from '../../src/components/timeline/Timeline';
import { InspectorPanel } from '../../src/components/InspectorPanel';
import type { InspectorPanelProps } from '../../src/components/inspector/InspectorTypes';
import { CaptionsPanel } from '../../src/captions/CaptionsPanel';
import { CaptionPreviewEditor } from '../../src/captions/CaptionPreviewEditor';
import { SoundBrowser } from '../../src/library/SoundBrowser';
import { FontLibraryProvider } from '../../src/fonts/FontLibraryProvider';
import { useEditor } from '../../src/editor/store';
import { useEditorSelectionState } from '../../src/editor/useEditorSelectionState';
import { resolveCaptionSelection } from '../../src/captions/captionSelection';
import type { ProjectDoc } from '../../src/editor/types';
import type { TimelineShortcutApi } from '../../src/shortcuts/timelineApi';
import { placeSound } from '../../src/audio/soundPlacement';
import { newManualCaptions } from '../../src/captions/manualCaptions';
import { newTranscriptGeneration } from '../../src/transcript/identity';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import type { DesktopAsrResponse } from '../../shared/desktop-inference';
import { applySkin, initSkins } from '../../src/skins';
import '../../src/index.css';

initSkins(); applySkin('constructivist');
const noop = () => undefined;
const SAVE_KEY = 'cc.qa.jianying-workflow.saved';
const qa = { doc: {} as ProjectDoc, frame: 0, playing: false, canUndo: false, canRedo: false,
  events: [] as Array<Record<string, unknown>>, selectedMediaIds: [] as string[], selectedCaptions: [] as unknown[],
  requests: [] as string[], cancels: [] as string[], mockAsr: false,
  nativeFonts: !!window.openChatCutDesktop?.fonts,
  getDoc: () => ({} as ProjectDoc), save: () => ({} as ProjectDoc), seek: (_frame: number) => undefined,
};
(window as unknown as { jianyingQA: typeof qa }).jianyingQA = qa;
const record = (event: Record<string, unknown>) => { qa.events.push(event); if (qa.events.length > 500) qa.events.shift(); };
const pending = new Map<string, (response: DesktopAsrResponse) => void>();
if (new URLSearchParams(location.search).get('mockAsr') === '1') {
  const native = window.openChatCutDesktop;
  const inference = { getCapabilities: async () => ({ asr: { available: true, contractId: ASR_INFERENCE_CONTRACT.id } }),
    subscribeProgress: () => noop,
    transcribe: ({ requestId }: { requestId: string }) => new Promise<DesktopAsrResponse>((resolve) => { qa.requests.push(requestId); pending.set(requestId, resolve); }),
    cancel: async (requestId: string) => { qa.cancels.push(requestId); },
  };
  try {
    // Preserve all native APIs, especially fonts. Immutable preloads are left intact.
    window.openChatCutDesktop = { ...native, inference } as unknown as NonNullable<Window['openChatCutDesktop']>;
    qa.mockAsr = window.openChatCutDesktop.inference === inference;
  } catch { record({ type: 'mock-asr-unavailable', reason: 'immutable native preload retained' }); }
}

const initial: ProjectDoc = { version: CURRENT_PROJECT_VERSION, assets: [{ id: 'video-source', name: '短视频素材', kind: 'video',
  src: '/media/uploads/jianying-fixture.mp4', durationInFrames: 180, width: 640, height: 360 }],
  mediaFolders: [], activeTimelineId: 'main', timelines: [{ id: 'main', name: '五项日常操作验收', order: 0,
    fps: 30, width: 640, height: 360, selectedId: null, trackOrder: ['captions', 'title', 'video', 'voice', 'sound'],
    tracks: { captions: { kind: 'caption', name: '字幕', captions: { ...newManualCaptions(), sourceEntries: [
      { id: 'source-captions', itemId: 'video' }, { id: 'manual-captions', itemId: 'manual:manual-captions', words: [
        { id: 'manual-first', text: '手动字幕第一句', start: 3500, end: 4200 },
        { id: 'manual-second', text: '手动字幕第二句', start: 4400, end: 5200 },
      ] },
    ] } }, title: { kind: 'video', name: '标题' }, video: { kind: 'video', name: '主轨道' }, voice: { kind: 'audio', name: '关联原声' }, sound: { kind: 'audio', name: '音效' } },
    linkGroups: [{ id: 'linked-av', mode: 'linked', anchorItemId: 'video', itemIds: ['video', 'voice'] }],
    items: [
      { id: 'video', name: '真实短视频', kind: 'video', track: 'video', src: '/media/uploads/jianying-fixture.mp4', sourceAssetId: 'video-source',
        startFrame: 0, durationInFrames: 180, volume: 0, ...newTranscriptGeneration([
          { text: '来源字幕第一句。', start: 0, end: 1000 }, { text: '来源字幕第二句。', start: 1400, end: 2500 },
        ]) },
      { id: 'title', name: '章节标题', kind: 'text', track: 'title', startFrame: 30, durationInFrames: 90,
        props: { text: '第一章 · 日常剪辑', fontSize: 42, fontFamily: 'Noto Sans SC', color: '#ffffff', align: 'center' } },
      { id: 'voice', name: '关联原声', kind: 'audio', track: 'voice', src: '/media/uploads/jianying-fixture.mp4',
        sourceAssetId: 'video-source', startFrame: 0, durationInFrames: 180, volume: .7 },
    ] }] };
function loadInitial(): ProjectDoc {
  try { const saved = JSON.parse(sessionStorage.getItem(SAVE_KEY) ?? 'null'); return saved?.version === CURRENT_PROJECT_VERSION && saved?.timelines?.length ? saved : initial; }
  catch { return initial; }
}

function Harness() {
  const { state, doc, commands, canUndo, canRedo } = useEditor(loadInitial());
  const selection = useEditorSelectionState(state, doc, commands, 'jianying-ui');
  const liveDoc = useRef(doc); liveDoc.current = doc;
  const liveState = useRef(state); liveState.current = state;
  const playerRef = useRef<PlayerRef | null>(null);
  const shortcutApiRef = useRef<TimelineShortcutApi | null>(null);
  const [tab, setTab] = useState<'captions' | 'sound'>('captions');
  const [notice, setNotice] = useState('');
  const [frame, setFrame] = useState(0);
  const item = selection.selectedItem;
  const seek = (next: number) => { if (shortcutApiRef.current) shortcutApiRef.current.seekTo(next); else playerRef.current?.seekTo(next); };
  qa.seek = seek;
  qa.getDoc = () => JSON.parse(JSON.stringify(liveDoc.current));
  qa.save = () => { const snapshot = qa.getDoc(); sessionStorage.setItem(SAVE_KEY, JSON.stringify(snapshot)); record({ type: 'save', assets: snapshot.assets.length }); return snapshot; };
  useEffect(() => {
    qa.doc = JSON.parse(JSON.stringify(doc)); qa.canUndo = canUndo; qa.canRedo = canRedo;
    qa.selectedMediaIds = [...selection.selectedIds]; qa.selectedCaptions = [...selection.captionSelections];
    record({ type: 'state', items: state.items.length, selectedMediaIds: qa.selectedMediaIds, selectedCaptions: qa.selectedCaptions });
  }, [doc, canUndo, canRedo, selection.selectedIds.join('|'), selection.captionSelections]);
  useEffect(() => {
    const player = playerRef.current; if (!player) return;
    const update = ({ detail }: { detail: { frame: number } }) => {
      qa.frame = detail.frame; qa.playing = player.isPlaying(); setFrame(detail.frame);
      requestAnimationFrame(() => {
        try {
          const canvas = document.querySelector<HTMLCanvasElement>('#actual-preview canvas');
          const pixel = canvas?.getContext('2d')?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
          record({ type: 'frame', frame: detail.frame, pixel: pixel ? [...pixel] : [], decoded: (pixel?.[3] ?? 0) > 0 });
        } catch (error) { record({ type: 'frame-sample-error', error: String(error) }); }
      });
    };
    player.addEventListener('frameupdate', update); return () => player.removeEventListener('frameupdate', update);
  }, []);
  const panel: InspectorPanelProps = {
    templates: [], selectedItem: item, selectedItems: selection.selectedItems, selectedIds: selection.selectedIds,
    selectedCaption: selection.selectedCaption ? { ...selection.selectedCaption,
      fontTargets: selection.captionSelections.filter((entry) => entry.trackId === selection.selectedCaption!.trackId)
        .flatMap((entry) => { const resolved = resolveCaptionSelection(state, entry); return resolved ? [resolved.target] : []; }),
    } : null,
    onCaptionUpdate: (patch) => { if (selection.selectedCaption) commands.updateCaptions(patch, selection.selectedCaption.trackId); },
    fps: 30, canvasWidth: 640, canvasHeight: 360, collapsed: false, onCollapsedChange: noop,
    onItemPropChange: (key, value) => { if (item) commands.updateItemProps(item.id, { [key]: value }); },
    onItemVolumeChange: (volume) => { if (item) commands.setItemVolume(item.id, volume); },
    onItemFadeChange: (fade) => { if (item) commands.setItemFade(item.id, fade); },
    onItemTransformChange: (patch) => { if (item) commands.setItemTransform(item.id, patch); },
    onItemCropChange: noop, onItemFiltersChange: noop, onItemMaskChange: noop, onItemZoomChange: noop, onItemEffectsChange: noop,
    onSetReframeKeyframe: noop, onRemoveReframeKeyframe: noop, onSetItemKeyframe: noop, onRemoveItemKeyframe: noop, onResetItemKeyframes: noop,
    onSeek: seek, getPlayhead: () => playerRef.current?.getCurrentFrame() ?? 0, transition: null,
    onAddTransition: noop, onSetTransition: noop, onRemoveTransition: noop, playerRef,
    historyGesture: { begin: commands.beginHistoryGesture, end: commands.endHistoryGesture },
    animationPreview: { playerRef, scope: { projectId: 'jianying-ui', timelineId: doc.activeTimelineId },
      getScope: () => ({ projectId: 'jianying-ui', timelineId: liveDoc.current.activeTimelineId }), onSeek: seek },
  };
  return <FontLibraryProvider assets={doc.assets} onAddAsset={commands.addAsset} historyGesture={{ begin: commands.beginHistoryGesture, end: commands.endHistoryGesture }}>
    <main style={{ padding: 16, color: 'var(--cc-text)', fontSize: 15, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 22 }}>字体、片段动画、字幕列表、音效、智能分镜：短素材验收</h1>
      <p>正式编辑器与真实短视频；字体使用实际桌面接口。ASR模拟：{qa.mockAsr ? '已开启（不验证识别准确度）' : '关闭'}；字体桌面接口：{qa.nativeFonts ? '可用' : '不可用，不能宣称Windows字体验收通过'}。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button onClick={() => { selection.selectCaption(null); commands.selectItem('video'); }}>选择视频</button>
        <button onClick={() => { selection.selectCaption(null); commands.selectItem('title'); }}>选择标题</button>
        <button onClick={() => setTab('captions')}>打开字幕列表</button><button onClick={() => setTab('sound')}>打开音效</button>
        <button onClick={() => seek(45)}>播放头到45帧</button><button onClick={commands.undo} disabled={!canUndo}>撤销</button><button onClick={commands.redo} disabled={!canRedo}>重做</button>
        <button onClick={() => { qa.save(); setNotice('工程JSON已保存到隔离会话，刷新可重开'); }}>保存工程JSON</button>
        <button onClick={() => { sessionStorage.removeItem(SAVE_KEY); commands.applyDoc(initial); selection.selectCaption(null); }}>重置测试工程</button>
        {qa.mockAsr && <button onClick={() => { for (const [requestId, resolve] of pending) resolve({ requestId, backend: 'native-cpu', text: '模拟识别第一句', chunks: [{ text: '模拟识别第一句', start: 0, end: 1000 }] }); pending.clear(); }}>完成模拟识别</button>}
      </div>
      <output id="actual-frame">当前画面帧：{frame}</output>{notice && <p role="status">{notice}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '360px 540px minmax(320px,1fr)', gap: 16, margin: '12px 0' }}>
        <section className="cc-library-content" style={{ height: 560, overflow: 'auto', padding: 10 }}>
          {tab === 'sound' ? <SoundBrowser fps={30} onAuditionStart={() => playerRef.current?.pause()} onAdd={(asset) => placeSound(liveState.current, commands, asset,
            { startFrame: playerRef.current?.getCurrentFrame() ?? 0 }, setNotice)} /> : <CaptionsPanel draftKey="jianying-ui:main" playerRef={playerRef} fps={30} items={state.items}
              captionTracks={selection.captionTracks} trackOptions={selection.trackOptions} selectedItem={item}
              selectedCaptions={selection.captionSelections} onSelectCaption={(value, options) => { commands.selectItem(null); selection.selectCaption(value, options); }}
              onSelectCaptionRange={(values, options) => { commands.selectItem(null); selection.selectMarqueeCaptions(values, options); }}
              onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} onCreateCaptionTrack={commands.createCaptionTrack} />}
        </section>
        <div id="actual-preview" style={{ position: 'relative', width: 540, height: 304 }}>
          <Player ref={playerRef} component={TimelineComposition} inputProps={{ state, project: doc, timelineId: doc.activeTimelineId, selectedItemId: item?.id }}
            durationInFrames={180} fps={30} compositionWidth={640} compositionHeight={360} style={{ width: 540 }} controls={false} clickToPlay={false} spaceKeyToPlayOrPause={false} acknowledgeRemotionLicense />
          {selection.captionTracks.map((track) => track.captions && <CaptionPreviewEditor key={track.id} trackId={track.id} state={state} captions={track.captions}
            playerRef={playerRef} onUpdateCaptions={(patch) => commands.updateCaptions(patch, track.id)} onSelectCaption={selection.selectCaption}
            activeSelection={selection.captionSelection?.trackId === track.id ? selection.captionSelection : null} />)}
        </div>
        <section style={{ height: 560, overflow: 'auto' }}><InspectorPanel {...panel} /></section>
      </div>
      <div style={{ height: 300 }}><Timeline state={state} projectDoc={doc} commands={commands} playerRef={playerRef} projectId="jianying-ui" shortcutApiRef={shortcutApiRef}
        selectedCaptions={selection.captionSelections} onSelectCaption={selection.selectCaption} onMarqueeCaptionSelect={selection.selectMarqueeCaptions} /></div>
    </main>
  </FontLibraryProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness />);

