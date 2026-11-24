import { useEffect, useMemo, useState } from 'react';
import type { ProjectQuickStart } from '../app/projectQuickStart';
import { useAutoMusicAnalysis } from '../audio/intelligence/useAutoMusicAnalysis';
import { isolateVoiceOnSrc } from '../audio/isolateVoice';
import { normalizeSelectedLoudness } from '../audio/normalizeSelectedLoudness';
import { placeSound } from '../audio/soundPlacement';
import { resolveFirstCaptionSelection, resolveOrderedCaptionSelections } from '../captions/captionSelection';
import { serializableDefsFor } from '../gl/fx/effects';
import { useT } from '../i18n/locale';
import { importMedia } from '../media/upload';
import { useEditorMediaIngest } from '../media/useEditorMediaIngest';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { showAppToast } from '../ui/appToast';
import { flexCropInsetPatch } from './flexCrop';
import { isBackgroundFillEligible } from './backgroundFill';
import type { EditorWorkspaceViewProps } from './EditorWorkspaceView';
import { planInspectorBatch } from './inspectorBatch';
import { supportsKeyframeProperty } from './keyframeRegistry';
import { keyframeResetBatch } from './keyframeReset';
import { captureTimelineItemSource, validateTimelineItemSourceBatch } from './mediaSourceRevision';
import { useEditor } from './store';
import { captionsOnTrack, type ProjectDoc } from './types';
import { applyLiveCaptionPreview, type LiveCaptionPreviewPatch } from './liveCaptionPreview';
import { useEditorAgentEnvironment } from './useEditorAgentEnvironment';
import { useEditorAutoGrade } from './useEditorAutoGrade';
import { useEditorProjectPersistence } from './useEditorProjectPersistence';
import { useEditorSelectionState } from './useEditorSelectionState';
import {
  useEditorWorkspaceDialogs,
  useEditorWorkspaceExportActions,
  useEditorWorkspacePanels,
} from './useEditorWorkspaceUi';

export interface EditorProps {
  initial: ProjectDoc;
  project: ProjectMeta;
  quickStart?: ProjectQuickStart;
  onHome: () => void;
  onRename: (name: string) => void;
}

function useEditorBaseStage({ initial, project }: EditorProps) {
  const t = useT();
  const editor = useEditor(initial);
  useAutoMusicAnalysis(editor.doc.assets);
  const selection = useEditorSelectionState(editor.state, editor.doc, editor.commands, project.id);
  return { ...editor, selection, t };
}

function useEditorEnvironmentStage(props: EditorProps, base: BaseStage) {
  const agent = useEditorAgentEnvironment({
    state: base.state,
    doc: base.doc,
    commands: base.commands,
    projectId: props.project.id,
    selectedItemId: base.selection.selectedItem?.id,
    selectedTransitionId: base.selection.selectedTransition?.id,
    getUndoTarget: base.getUndoTarget,
    getRedoTarget: base.getRedoTarget,
    onRename: props.onRename,
    translate: base.t,
  });
  const autoGrade = useEditorAutoGrade({
    state: base.state,
    stateRef: agent.stateRef,
    commands: base.commands,
    projectId: props.project.id,
    t: base.t,
    setPreviewState: agent.setPreviewState,
  });
  return { agent, autoGrade };
}

function useEditorUiStage(props: EditorProps, base: BaseStage, environment: EnvironmentStage) {
  const { state, doc, commands, selection, t } = base;
  const { agent } = environment;
  const [exportZone, setExportZone] = useState<{ inFrame: number | null; outFrame: number | null }>({ inFrame: null, outFrame: null });
  const [liveCaptionPreview, setLiveCaptionPreview] = useState<LiveCaptionPreviewPatch | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  useEffect(() => { setLiveCaptionPreview(null); setPreviewAssetId(null); }, [doc.activeTimelineId]);
  const previewAsset = useMemo(
    () => (previewAssetId ? doc.assets.find((asset) => asset.id === previewAssetId) ?? null : null),
    [doc.assets, previewAssetId],
  );
  useEffect(() => {
    if (previewAssetId && (!previewAsset || liveCaptionPreview || agent.previewState || environment.autoGrade.autoGradePreviewState)) {
      setPreviewAssetId(null);
    }
  }, [agent.previewState, environment.autoGrade.autoGradePreviewState, liveCaptionPreview, previewAsset, previewAssetId]);
  const liveState = useMemo(
    () => applyLiveCaptionPreview(state, doc.activeTimelineId, liveCaptionPreview),
    [state, doc.activeTimelineId, liveCaptionPreview],
  );
  const effectiveCaptionTracks = useMemo(
    () => liveCaptionPreview?.source === 'list'
      ? selection.captionTracks
      : selection.captionTracks.map((track) => ({ ...track, captions: captionsOnTrack(liveState, track.id) })),
    [selection.captionTracks, liveCaptionPreview?.source, liveState],
  );
  const dialogs = useEditorWorkspaceDialogs({ projectId: props.project.id, doc, playerRef: agent.playerRef });
  const persistence = useEditorProjectPersistence({
    projectId: props.project.id, doc, commands, stateRef: agent.stateRef, docRef: agent.docRef,
    playerRef: agent.playerRef, flushBeforeLeaveRef: agent.flushBeforeLeaveRef, onHome: props.onHome,
  });
  const panels = useEditorWorkspacePanels({ commands });
  const ingest = useEditorMediaIngest({
    commands, projectId: props.project.id, assets: doc.assets, stateRef: agent.stateRef,
    docRef: agent.docRef, getPlayhead: dialogs.getPlayhead, t,
  });
  const exportActions = useEditorWorkspaceExportActions({
    commands, docRef: agent.docRef, stateRef: agent.stateRef, fps: state.fps, projectId: props.project.id, t,
    shortcutApiRef: dialogs.shortcutApiRef, setShowDesign: dialogs.setShowDesign,
    setShowVersions: dialogs.setShowVersions, setShowShortcuts: dialogs.setShowShortcuts,
    setShowSettings: dialogs.setShowSettings, toggleLayout: () => panels.setInspectorCollapsed((v) => !v), selectAllTimelineContent: selection.selectAllTimelineContent,
  });
  return { dialogs, persistence, panels, ingest, exportActions, exportZone, setExportZone, liveCaptionPreview, setLiveCaptionPreview, liveState, effectiveCaptionTracks, previewAssetId, setPreviewAssetId, previewAsset };
}

type BaseStage = ReturnType<typeof useEditorBaseStage>;
type EnvironmentStage = ReturnType<typeof useEditorEnvironmentStage>;
type UiStage = ReturnType<typeof useEditorUiStage>;

function buildEditorWorkspaceViewProps(
  props: EditorProps,
  base: BaseStage,
  environment: EnvironmentStage,
  ui: UiStage,
): EditorWorkspaceViewProps {
  const { project, onRename } = props;
  const { state, doc, commands, canUndo, canRedo, selection, t } = base;
  const { activeSlipPreview, activeTimelineAssetIds, captionSelection, captionSelections, captionTracks, reviewRequest, selectCaption, selectMarqueeCaptions, selectedCaption, selectedIds, selectedItem, selectedItems, selectedSlipPlan, selectedTransition, getSequenceOptions, setActiveSlipPreview, setReviewRequest, setTimelineHoverPreviewFrame, timelineHoverPreviewFrame, trackOptions, usedAssetIds } = selection;
  const { historyGesture, stateRef, applyInspectorSelection, docRef, offlineSrcs, offlineAssetIds, markOffline: markMediaOffline, playerRef, selectedPreviewStatuses, handleSelectedPreviewStatus, allTemplates, agentCtx, previewState, setPreviewState } = environment.agent;
  const { autoGradeBusy, autoGradeSession, autoGradeTargets, cancelAutoGrade, analyzeSelectedColor, applyAutoGrade, autoGradePreviewState, selectedAutoGrade } = environment.autoGrade;
  const { showDesign, setShowDesign, showVersions, setShowVersions, showShortcuts, setShowShortcuts, showSettings, setShowSettings, shortcutApiRef, getPlayhead, pasteTranscriptRequest, requestPasteTranscript } = ui.dialogs;
  const { handleHome, saveStatus, saveError, retrySave } = ui.persistence;
  const { panelLayout, inspectorCollapsed, setInspectorCollapsed, addTemplate } = ui.panels;
  const { startAssetTranscription, ingestToPool, importMobileUpload, importToPool, dropExternalFilesToTimeline, addMediaAssetsToTimeline, importToCanvas, pasteMediaAssets } = ui.ingest;
  const { exportJobs, activeExportJobs, exportOpen, setExportOpen, relinkMediaAsset } = ui.exportActions;
  const { exportZone, setExportZone, liveCaptionPreview, setLiveCaptionPreview, liveState, effectiveCaptionTracks } = ui;
  const effectiveTimelineState = liveCaptionPreview?.source === 'timeline' ? state : liveState;
  const effectiveListState = liveCaptionPreview?.source === 'list' ? state : liveState;
  const effectiveCaption = selectedCaption ?? (!selectedItem ? resolveFirstCaptionSelection(state) : null);
  const workspace: EditorWorkspaceViewProps = {
    gridTemplateColumns: panelLayout.gridTemplateColumns,
    gridTemplateRows: panelLayout.gridTemplateRows,
    librarySize: panelLayout.librarySize,
    timelineSize: panelLayout.timelineSize,
    topBar: { projectId: project.id, projectName: project.name, saveStatus, saveError, onRetrySave: retrySave, exporting: activeExportJobs > 0, exportJobCount: activeExportJobs, canUndo, canRedo, onHome: handleHome, onRename },
    exportDialog: exportOpen ? { state, project: doc, projectId: project.id, projectName: project.name, exportJobs, zoneIn: exportZone.inFrame, zoneOut: exportZone.outFrame, onClose: () => setExportOpen(false) } : null,
    designStylePanel: showDesign ? { style: doc.designStyle, onApply: commands.setDesignStyle, onClose: () => setShowDesign(false) } : null,
    versionHistory: showVersions ? { projectId: project.id, currentDoc: doc, onRestore: (d) => { commands.applyDoc(d); setShowVersions(false); }, onClose: () => setShowVersions(false) } : null,
    shortcutsDialog: showShortcuts ? { onClose: () => setShowShortcuts(false) } : null,
    settingsDialog: showSettings ? { onClose: () => { setShowSettings(false); } } : null,
    externalControl: { ctx: agentCtx, projectId: project.id, onPreviewState: setPreviewState },
    libraryPanel: { onRequestPasteTranscript: requestPasteTranscript, onAddText: () => { const id = commands.addTextClip({ startFrame: getPlayhead(), durationInFrames: state.fps * 3, text: '输入标题' }); commands.selectItem(id); }, timelineId: doc.activeTimelineId, quickStart: props.quickStart, semanticScopeId: project.id, templates: allTemplates, onAddTemplate: addTemplate, onAddAudio: (a) => { commands.addAudio(a); }, playerRef, fps: state.fps, items: effectiveListState.items, trackOptions, captionTracks: effectiveCaptionTracks, onSetCaptions: commands.setCaptions, onUpdateCaptions: commands.updateCaptions, onLiveUpdateCaptions: (patch, track) => setLiveCaptionPreview(patch ? { kind: 'patch', source: 'list', timelineId: docRef.current.activeTimelineId, trackId: track ?? captionTracks[0]?.id, patch } : null), onSetItemTranscript: commands.setItemTranscript, onToggleWord: commands.toggleWord, onCleanScript: commands.cleanScript, onSetGapCap: commands.setGapCap, onSetTranscriptPlayOrder: commands.setTranscriptPlayOrder, onReorderTrackItems: commands.reorderTrackItems, onClearEdits: commands.clearEdits, assets: state.assets ?? [], mediaFolders: doc.mediaFolders, usedAssetIds, onTimelineAssetIds: activeTimelineAssetIds, previewAssetId: ui.previewAssetId, onPreviewAsset: (asset) => ui.setPreviewAssetId(asset ? asset.id : null), offlineAssetIds, onAssetLoadError: (asset) => markMediaOffline(asset.src), onImportMedia: importToPool, onImportMobileMedia: importMobileUpload, onIngestDirectoryAsset: ingestToPool, onTranscribeAsset: startAssetTranscription, onAddMediaItem: (asset, options) => commands.addMediaItem(asset, options), onAddMediaAssetsToTimeline: addMediaAssetsToTimeline, onPasteMediaAssets: pasteMediaAssets, onCreateMediaFolder: commands.createMediaFolder, onRenameMediaFolder: commands.renameMediaFolder, onDeleteMediaFolder: commands.deleteMediaFolder, onMoveMediaAssets: commands.moveMediaAssets, onRenameMediaAsset: commands.renameMediaAsset, onRenameMediaAssets: commands.renameMediaAssets, onSetMediaAssetFavorite: commands.setMediaAssetFavorite, onSetMediaAssetsFavorite: commands.setMediaAssetsFavorite, onRemoveMediaAsset: commands.removeMediaAsset, onRemoveMediaAssets: commands.removeMediaAssets, onCreateCaptionTrack: commands.createCaptionTrack, getSequenceOptions, onAddSequence: (timelineId) => { const result = commands.addSequence(timelineId, { startFrame: getPlayhead() }); if (!result.ok) showAppToast(t(result.error), { error: true }); }, onRelinkMediaAsset: relinkMediaAsset, onAddSolid: (preset) => { const id = commands.addSolidItem({ startFrame: getPlayhead(), ...preset }); commands.selectItem(id); }, onAddShape: (shape: 'rectangle' | 'ellipse') => { const id = commands.addShapeItem(shape, { startFrame: getPlayhead() }); commands.selectItem(id); }, onAddMosaic: () => { const id = commands.addCompositionMosaic({ startFrame: getPlayhead() }); commands.selectItem(id); }, selectedItem, onApplyTransition: (type, custom) => { const targetId = stateRef.current.selectedId; const target = targetId ? stateRef.current.items.find((x) => x.id === targetId) : undefined; if (!target || target.kind === 'audio') { showAppToast(t('请先选中一个视觉片段，或直接拖到时间线片段上')); return; } const hasAdjacentPrev = stateRef.current.items.some((other) => other.id !== target.id && other.track === target.track && other.startFrame + other.durationInFrames === target.startFrame); if (!hasAdjacentPrev) { showAppToast(t('转场需要放在同一轨道相邻两段之间（请选中后方紧邻片段）')); return; } commands.addTransition(target.id, type, undefined, custom); }, onApplyFx: (assetId) => { const targetId = stateRef.current.selectedId; const it = targetId ? stateRef.current.items.find((x) => x.id === targetId) : undefined; if (!it || (it.kind !== 'video' && it.kind !== 'image')) { showAppToast(t('特效与 LUT 仅支持视频或图片片段（不叠加在字幕上）')); return; } const prev = it.effects ?? []; const next = [...prev.filter((e) => e.assetId !== assetId), { id: `fx_${assetId}`, assetId, overrides: {} }]; commands.setItemEffects(it.id, next, serializableDefsFor(next)); }, onApplyZoom: (zoom) => { const targetId = stateRef.current.selectedId; const it = targetId ? stateRef.current.items.find((x) => x.id === targetId) : undefined; if (!it || it.kind === 'audio') { showAppToast(t('推拉缩放仅支持视觉片段')); return; } commands.setItemZoom(it.id, zoom); }, pasteTranscriptRequest },
    onResizeLibrary: panelLayout.resizeLibrary,
    onResizeLibraryStart: panelLayout.beginLibraryResize,
    onResizeLibraryCancel: panelLayout.cancelLibraryResize,
    onResetLibrarySize: panelLayout.resetLibrarySize,
    previewPanel: { state: autoGradePreviewState ?? previewState ?? liveState, project: doc, projectName: project.name, zoneIn: exportZone.inFrame, zoneOut: exportZone.outFrame, playerRef, onImport: importToCanvas, hoverPreviewFrame: timelineHoverPreviewFrame, projectId: project.id, timelineId: doc.activeTimelineId, reviewState: state, selectedItem, reviewRequest, offlineSrcs, previewAsset: ui.previewAsset, onClosePreviewAsset: () => ui.setPreviewAssetId(null), onAddPreviewAsset: (asset) => { ui.setPreviewAssetId(null); commands.addMediaItem(asset, { startFrame: getPlayhead() }); }, onUpdateCaptions: previewState || autoGradePreviewState ? undefined : commands.updateCaptions, onLiveCaptionsPreview: previewState || autoGradePreviewState ? undefined : (trackId, patch) => setLiveCaptionPreview(patch ? { kind: 'patch', source: 'preview', timelineId: docRef.current.activeTimelineId, trackId, patch } : null), onSelectCaption: previewState || autoGradePreviewState ? undefined : selectCaption, activeCaptionSelection: captionSelection, ...(!previewState && !autoGradePreviewState ? { onSelectItem: commands.selectItem, onSetItemTransform: commands.setItemTransform, onSetItemKeyframe: commands.setItemKeyframe, onRemoveItemKeyframe: commands.removeItemKeyframe, onSeek: (frame: number) => shortcutApiRef.current?.seekTo(frame), onBeginHistoryGesture: commands.beginHistoryGesture, onEndHistoryGesture: commands.endHistoryGesture, onItemPropChange: (id, key, value) => commands.updateItemProps(id, { [key]: value }), onSetItemMask: (id, mask) => commands.batch([{ type: 'setMask', id, mask }], 'Adjust mask'), onSetCompositionMosaic: (id, patch) => commands.batch([{ type: 'setCompositionMosaic', id, patch }], 'Adjust mosaic') } : {}), inspectorOpen: !!(selectedItem || selectedCaption) && !inspectorCollapsed, selectedPreviewStatuses, onSelectedPreviewStatus: handleSelectedPreviewStatus, slipPreview: activeSlipPreview, onToggleInspector: () => setInspectorCollapsed((collapsed) => !collapsed) },
    inspectorPanel: { playerRef, historyGesture, templates: allTemplates, selectedItem, selectedCaption: effectiveCaption, onCaptionUpdate: (patch) => effectiveCaption && commands.updateCaptions(patch, effectiveCaption.trackId), selectedIds, selectedItems, fps: state.fps, canvasWidth: state.width, canvasHeight: state.height, collapsed: false, onCollapsedChange: setInspectorCollapsed, onItemPropChange: (key, value) => applyInspectorSelection((item) => ({ type: 'updateProps', id: item.id, patch: { [key]: value } }), (item) => selectedItem ? item.kind === selectedItem.kind : false), onItemVolumeChange: (volume) => applyInspectorSelection((item) => ({ type: 'setVolume', id: item.id, volume }), (item) => item.kind === 'audio' || item.kind === 'video'), onItemFadeChange: (fade) => applyInspectorSelection((item) => ({ type: 'setFade', id: item.id, ...fade })), onItemTransformChange: (patch) => applyInspectorSelection((item) => ({ type: 'setTransform', id: item.id, patch }), (item) => item.kind !== 'audio'), onItemCropChange: (edge, value) => applyInspectorSelection((item) => ({ type: 'setTransform', id: item.id, patch: flexCropInsetPatch(item.transform?.crop, edge, value) }), (item) => item.kind !== 'audio'), onItemFiltersChange: (patch) => { if (autoGradeBusy || autoGradeSession) cancelAutoGrade(); applyInspectorSelection((item) => ({ type: 'setFilters', id: item.id, patch }), (item) => item.kind !== 'audio'); }, onItemMaskChange: (mask) => applyInspectorSelection((item) => ({ type: 'setMask', id: item.id, mask }), (item) => item.kind !== 'audio'), onCompositionMosaicChange: (patch) => applyInspectorSelection((item) => ({ type: 'setCompositionMosaic', id: item.id, patch }), (item) => item.kind === 'mosaic'), backgroundFillAvailable: selectedItems.length > 0 && selectedItems.every((item) => isBackgroundFillEligible(state, item)), onItemBackgroundFillChange: (enabled, strength) => applyInspectorSelection((item) => ({ type: 'setBackgroundFill', id: item.id, enabled, strength }), (item) => isBackgroundFillEligible(state, item)), onApplyBackgroundFillToAll: (strength: number) => { const snapshot = stateRef.current; const actions = snapshot.items.filter((item) => isBackgroundFillEligible(snapshot, item)).map((item) => ({ type: 'setBackgroundFill' as const, id: item.id, enabled: true, strength })); if (actions.length === 0) return; commands.batch(actions, 'Apply background fill to all'); showAppToast(t('已将背景填充应用到 {n} 个片段', { n: actions.length })); }, autoGrade: { busy: autoGradeBusy, targetCount: autoGradeTargets.length, previewCount: autoGradeSession?.recommendations.length ?? 0, failedCount: autoGradeSession?.failedCount ?? 0, selectedPreview: selectedAutoGrade ? { filters: selectedAutoGrade.analysis.filters, bitDepth: selectedAutoGrade.analysis.profile.bitDepth, hdr: selectedAutoGrade.analysis.profile.hdr } : null, onAnalyze: analyzeSelectedColor, onApply: applyAutoGrade, onCancel: cancelAutoGrade }, onItemZoomChange: (patch) => applyInspectorSelection((item) => ({ type: 'setZoom', id: item.id, patch }), (item) => item.kind !== 'audio'), onItemEffectsChange: (effects) => { const defs = serializableDefsFor(effects); applyInspectorSelection((item) => ({ type: 'setEffects', id: item.id, effects, defs }), (item) => item.kind === 'video' || item.kind === 'image'); }, selectedPreviewStatuses, onItemSpeedChange: (rate) => applyInspectorSelection((item) => ({ type: 'setSpeed', id: item.id, rate }), (item) => item.kind === 'video' || item.kind === 'audio'), slipPlan: selectedSlipPlan, onItemSlip: selectedSlipPlan && selectedItem ? (deltaInFrames) => commands.slipItem(selectedItem.id, deltaInFrames) : undefined, onNormalizeLoudness: async () => { try { const result = await normalizeSelectedLoudness([...selectedItems], () => stateRef.current, () => docRef.current, commands); if (result.peakLimited) showAppToast(t('有 {n} 个片段已限制增益以避免新增削波；未达到目标响度。', { n: result.peakLimited })); } catch (error) { showAppToast(error instanceof Error ? error.message : t('\u54cd\u5ea6\u5206\u6790\u5931\u8d25\u3002'), { error: true }); } }, onIsolateVoice: async (action, strength) => { const ids = [...selectedIds]; const items = [...selectedItems]; if (!items.length || items.some((item) => (item.kind !== 'video' && item.kind !== 'audio'))) return; if (action === 'clear') { const plan = planInspectorBatch(stateRef.current, ids, (item) => ({ type: 'setItemDenoise', id: item.id, denoisedSrc: null }), (item) => item.kind === 'video' || item.kind === 'audio'); if (plan.ok) commands.batch(plan.actions, 'Clear selected voice isolation'); return; } if (items.some((item) => !item.src)) return; try { const sourceAssets = docRef.current.assets ?? []; const snapshots = items.map((item) => captureTimelineItemSource(item, sourceAssets)); const isolated = await Promise.all(snapshots.map(async (snapshot, index) => { const item = items[index]!; return [item.id, await isolateVoiceOnSrc(snapshot.src, typeof strength === 'number' ? strength : (item.denoiseStrength ?? 70), { force: true, sourceRevision: snapshot.sourceRevision })] as const; })); const resultById = new Map(isolated); const live = stateRef.current; const validation = validateTimelineItemSourceBatch(snapshots, live.items, docRef.current.assets ?? [], resultById); if (validation.status === 'stale') { showAppToast(t('所选片段的源素材已变化，旧的人声分离结果已丢弃。请重试。'), { error: true }); return; } const plan = planInspectorBatch(live, ids, (item) => { const result = resultById.get(item.id); return result ? { type: 'setItemDenoise' as const, id: item.id, denoisedSrc: result.path, strength: result.strength } : null; }, (item) => (item.kind === 'video' || item.kind === 'audio') && resultById.has(item.id)); if (plan.ok) commands.batch(plan.actions, 'Isolate selected voices'); } catch { showAppToast(t('人声分离失败，未修改任何片段。')); } }, getPlayhead, onSetReframeKeyframe: (frame, fx, fy, mag) => applyInspectorSelection((item) => ({ type: 'reframeKeyframe', id: item.id, frame, focalPointX: fx, focalPointY: fy, magnification: mag }), (item) => item.kind !== 'audio'), onRemoveReframeKeyframe: (frame) => applyInspectorSelection((item) => ({ type: 'removeReframeKeyframe', id: item.id, frame }), (item) => item.kind !== 'audio'), onSetItemKeyframe: (prop, frame, value, easing) => applyInspectorSelection((item) => ({ type: 'setKeyframe', id: item.id, prop, frame, value, easing }), (item) => supportsKeyframeProperty(item, prop)), onRemoveItemKeyframe: (prop, frame) => applyInspectorSelection((item) => ({ type: 'removeKeyframe', id: item.id, prop, frame }), (item) => supportsKeyframeProperty(item, prop)), onResetItemKeyframes: (props) => applyInspectorSelection((item) => keyframeResetBatch(item.id, props).actions, (item) => props.every((prop) => supportsKeyframeProperty(item, prop)), 'Reset selected keyframes'), onSeek: (frame) => shortcutApiRef.current?.seekTo(frame), transition: selectedTransition, onAddTransition: (type) => state.selectedId && commands.addTransition(state.selectedId, type), onSetTransition: (patch) => { const transition = state.transitions?.find((item) => item.incomingItemId === state.selectedId); if (transition) commands.setTransition(transition.id, patch); }, onRemoveTransition: () => { const transition = state.transitions?.find((item) => item.incomingItemId === state.selectedId); if (transition) commands.removeTransition(transition.id); } },
    onResizeTimeline: panelLayout.resizeTimeline,
    onResizeTimelineStart: panelLayout.beginTimelineResize,
    onResizeTimelineCancel: panelLayout.cancelTimelineResize,
    onResetTimelineSize: panelLayout.resetTimelineSize,
    timelineTabs: { doc, commands },
    timeline: { state: effectiveTimelineState, projectDoc: doc, commands, playerRef, projectId: project.id, shortcutApiRef, selectedCaptions: captionSelections, onSelectCaption: selectCaption, onMarqueeCaptionSelect: selectMarqueeCaptions, onLiveCaptionPreview: (preview) => setLiveCaptionPreview(preview ? { ...preview, timelineId: docRef.current.activeTimelineId } : null), onHoverPreviewFrameChange: setTimelineHoverPreviewFrame, onZoneChange: setExportZone, onDropExternalFiles: dropExternalFilesToTimeline, onReviewItem: (request) => setReviewRequest({ ...request, nonce: Date.now() }), onSlipPreview: setActiveSlipPreview, onRecordVoiceover: async (blob) => { const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'; const asset = await importMedia(new File([blob], `旁白.${ext}`, { type: blob.type }), state.fps); ingestToPool(asset); commands.addMediaItem(asset, { track: 'A1', startFrame: getPlayhead() }); } },
  };
  workspace.libraryPanel.onAddAudio = (asset) => placeSound(stateRef.current, commands, asset,
    { startFrame: getPlayhead() }, (message) => showAppToast(message, { error: true }));
  workspace.libraryPanel.selectedCaptions = captionSelections;
  workspace.libraryPanel.onSelectCaption = (caption, options) => { commands.selectItem(null); selectCaption(caption, options); };
  workspace.libraryPanel.onSelectCaptionRange = (captions, options) => { commands.selectItem(null); selectMarqueeCaptions(captions, options); };
  workspace.libraryPanel.onSeekFrame = (frame: number) => {
    if (shortcutApiRef.current) shortcutApiRef.current.seekTo(frame);
    else playerRef.current?.seekTo(frame);
  };
  workspace.fontLibrary = { assets: doc.assets, onAddAsset: commands.addAsset,
    historyGesture: { begin: commands.beginHistoryGesture, end: commands.endHistoryGesture } };
  if (workspace.inspectorPanel) {
    if (selectedCaption) workspace.inspectorPanel.selectedCaption = { ...selectedCaption,
      fontTargets: resolveOrderedCaptionSelections(state, captionSelections)
        .filter((selected) => selected.trackId === selectedCaption.trackId)
        .map((selected) => selected.target) };
    workspace.inspectorPanel.audioTracks = trackOptions.filter((track) => selectedItems.some((item) => item.track === track.id))
      .map((track) => ({ id: track.id, label: track.name || track.alias, config: state.tracks?.[track.id] ?? {} }));
    workspace.inspectorPanel.onAudioTrackChange = commands.updateTrack;
    workspace.inspectorPanel.animationPreview = !previewState && !autoGradePreviewState && selectedItems.length === 1 ? {
      playerRef,
      scope: { projectId: project.id, timelineId: doc.activeTimelineId },
      getScope: () => ({ projectId: project.id, timelineId: docRef.current.activeTimelineId }),
      onSeek: (frame) => {
        if (shortcutApiRef.current) shortcutApiRef.current.seekTo(frame);
        else playerRef.current?.seekTo(frame);
      },
    } : undefined;
  }
  return workspace;
}

export function useEditorController(props: EditorProps): EditorWorkspaceViewProps {
  const base = useEditorBaseStage(props);
  const environment = useEditorEnvironmentStage(props, base);
  const ui = useEditorUiStage(props, base, environment);
  return buildEditorWorkspaceViewProps(props, base, environment, ui);
}
