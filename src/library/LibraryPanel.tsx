import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SequenceLibraryOption } from './sequenceOptions';
import type { PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { Tpl } from '../types';
import type { ClipMask, MediaAsset, MediaAssetRelinkPatch, MediaFolder, TimelineItem, TrackId, TransitionType } from '../editor/types';
import type { MobileUploadRecord } from '../media/mobileUploadApi';
import type { CaptionsData } from '../captions/types';
import type { TranscriptWord } from '../transcript/types';
import type { AudioAsset } from '../audio/library';
import { type TranscriptTrackOption } from '../transcript/TranscriptPanel';
import { CaptionsPanel } from '../captions/CaptionsPanel';
import { MediaPoolPanel } from '../media/MediaPoolPanel';
import { useDirectoryImport } from '../media/useDirectoryImport';
import { SoundBrowser } from './SoundBrowser';
import { EffectsBrowser } from './EffectsBrowser';
import { ExtensionCenter } from './ExtensionCenter';
import type { ZoomEffect } from '../editor/types';
import type { MediaPlacementPurpose } from '../media/placementPurpose';
import type { ProjectQuickStart } from '../app/projectQuickStart';
import { QuickStartGuide } from './QuickStartGuide';
import { LibraryNavigation, isResourceTool, type LibraryTool } from './LibraryNavigation';
import type { MediaSourceRange, MediaSourceRanges } from '../editor/mediaSourceRange';
import type { CaptionSelectOptions, CaptionSelectionRef } from '../captions/captionSelection';

export interface LibraryPanelProps {
  timelineId: string;
  semanticScopeId: string;
  templates: Tpl[];
  onAddTemplate: (tpl: Tpl) => void;
  onAddAudio: (asset: AudioAsset) => boolean | void;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  getSequenceOptions: () => SequenceLibraryOption[];
  onAddSequence: (timelineId: string) => void;
  /** A1/V1 aliases + names for script track picker */
  trackOptions: TranscriptTrackOption[];
  captionTracks: Array<TranscriptTrackOption & { captions: CaptionsData | null }>;
  onSetCaptions: (c: CaptionsData | null, track?: TrackId) => void;
  onCreateCaptionTrack: (captions: CaptionsData, opts?: { name?: string; order?: number }) => TrackId;
  onUpdateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onLiveUpdateCaptions?: (patch: Partial<CaptionsData> | null, track?: TrackId) => void;
  selectedCaptions?: readonly CaptionSelectionRef[];
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onSelectCaptionRange?: (selections: CaptionSelectionRef[], options: { additive: boolean; preserveWithItems: boolean }) => void;
  onSeekFrame?: (frame: number) => void;
  onSetItemTranscript: (id: string, words: TranscriptWord[]) => void;
  onToggleWord: (id: string, idx: number) => void;
  onCleanScript: (id: string, opts: { silenceFrames?: number; removeFillers: boolean }) => void;
  onSetGapCap: (id: string, afterWordIndex: number, maxMs: number | null) => void;
  onSetTranscriptPlayOrder: (id: string, playOrder: number[] | null) => void;
  onReorderTrackItems: (track: string, orderedIds: string[]) => void;
  onClearEdits: (id: string) => void;
  assets: MediaAsset[];
  mediaFolders: MediaFolder[];
  usedAssetIds: ReadonlySet<string>;
  onTimelineAssetIds?: ReadonlySet<string>;
  previewAssetId?: string | null;
  onPreviewAsset?: (asset: MediaAsset | null) => void;
  offlineAssetIds: ReadonlySet<string>;
  onAssetLoadError: (asset: MediaAsset) => void;
  onImportMedia: (
    file: File,
    onProgress?: (ratio: number) => void,
    lifecycle?: {
      onPlaceholder?: (asset: MediaAsset) => void;
      onAssetUpdated?: (asset: MediaAsset) => void;
      onFailure?: (asset: MediaAsset | null, error: unknown) => void;
    },
  ) => Promise<MediaAsset>;
  onImportMobileMedia: (record: MobileUploadRecord) => Promise<void>;
  onIngestDirectoryAsset: (asset: MediaAsset) => void;
  onTranscribeAsset: (asset: MediaAsset) => void;
  onAddMediaItem: (asset: MediaAsset, options?: Partial<MediaSourceRange> & { volume?: number }) => void;
  onAddMediaAssetsToTimeline: (assets: MediaAsset[], options?: { purpose?: MediaPlacementPurpose; sourceRanges?: MediaSourceRanges }) => void;
  onCreateMediaFolder: (name: string, parentId?: string) => string;
  onRenameMediaFolder: (id: string, name: string) => void;
  onDeleteMediaFolder: (id: string) => void;
  onMoveMediaAssets: (ids: string[], folderId?: string) => void;
  onRenameMediaAsset: (id: string, name: string) => void;
  onRenameMediaAssets: (entries: Array<{ id: string; name: string }>) => void;
  onSetMediaAssetFavorite: (id: string, favorite: boolean) => void;
  onSetMediaAssetsFavorite: (ids: string[], favorite: boolean) => void;
  onRemoveMediaAsset: (id: string) => void;
  onRemoveMediaAssets: (ids: string[]) => void;
  onPasteMediaAssets: (assets: MediaAsset[], folderId?: string) => void;
  onRelinkMediaAsset?: (id: string, next: MediaAssetRelinkPatch) => void;
  onAddSolid?: (preset?: { name?: string; color?: string; props?: Record<string, unknown>; mask?: ClipMask }) => void;
  onAddShape?: (shape: 'rectangle' | 'ellipse') => void;
  onAddMosaic?: () => void;
  onAddText: () => void;
  /** currently-selected clip — resource-library tabs apply to it */
  selectedItem: TimelineItem | null;
  /** custom = plugin transition (type='custom-shader' snapshot frag into TransitionItem) */
  onApplyTransition: (type: TransitionType, custom?: { frag: string; uniforms: Record<string, number>; label: string }) => void;
  onApplyFx: (assetId: string) => void;
  /** The built-in curve passes {shape}; the plugin curve passes {envelope, label} (see PluginBrowser.asPluginZoom) */
  onApplyZoom: (zoom: ZoomEffect) => void;
  pasteTranscriptRequest?: number;
  quickStart?: ProjectQuickStart;
  textWorkspaceActive?: boolean;
  onOpenTextWorkspace?: (page: '字幕' | '文字稿剪辑') => void;
  onRequestPasteTranscript?: () => void;
}

const MAIN_TABS = ['我的素材', '特效', '字幕', '序列', '资源库'] as const;
function localizeDefaultSequenceName(name: string, t: ReturnType<typeof useT>): string {
  const match = /^序列 (\d+)$/.exec(name);
  return match ? t('序列 {n}', { n: match[1]! }) : name;
}
export const LibraryPanel = memo(function LibraryPanel({ timelineId, semanticScopeId, templates, onAddTemplate, onAddAudio, playerRef, fps, items, trackOptions, captionTracks, onSetCaptions, onCreateCaptionTrack, onUpdateCaptions, selectedCaptions, onSelectCaption, onSelectCaptionRange, onSeekFrame, selectedItem, onAddText, pasteTranscriptRequest = 0, getSequenceOptions, onAddSequence, assets, mediaFolders, usedAssetIds, onTimelineAssetIds, previewAssetId, onPreviewAsset, offlineAssetIds, onAssetLoadError, onImportMedia, onImportMobileMedia, onIngestDirectoryAsset, onTranscribeAsset, onAddMediaItem, onAddMediaAssetsToTimeline, onCreateMediaFolder, onRenameMediaFolder, onDeleteMediaFolder, onMoveMediaAssets, onRenameMediaAsset, onRenameMediaAssets, onSetMediaAssetFavorite, onSetMediaAssetsFavorite, onRemoveMediaAsset, onRemoveMediaAssets, onPasteMediaAssets, onRelinkMediaAsset, onAddSolid, onAddShape, onAddMosaic, onApplyTransition, onApplyFx, onApplyZoom, quickStart, onOpenTextWorkspace, onRequestPasteTranscript }: LibraryPanelProps) {
  const t = useT();
  const [mainTab, setMainTab] = useState<(typeof MAIN_TABS)[number]>(quickStart === 'captions' ? '字幕' : '我的素材');
  const [activeTool, setActiveTool] = useState<LibraryTool>(quickStart === 'captions' ? '字幕' : '我的素材');
  const [quickStartVisible, setQuickStartVisible] = useState(Boolean(quickStart));
  const [quickImportRequested, setQuickImportRequested] = useState(false);
  const [extensionOpen, setExtensionOpen] = useState(false);
  const [directoryImportError, setDirectoryImportError] = useState<string | null>(null);
  const lastPasteRef = useRef(pasteTranscriptRequest);
  const scopeIdentity = `${semanticScopeId}:${timelineId}`;
  useEffect(() => {
    if (pasteTranscriptRequest > lastPasteRef.current) {
      lastPasteRef.current = pasteTranscriptRequest;
      setExtensionOpen(false);
      setActiveTool('字幕');
      setMainTab('字幕');
    }
  }, [pasteTranscriptRequest]);
  const directoryImport = useDirectoryImport({
    projectId: semanticScopeId,
    fps,
    assets,
    ingest: onIngestDirectoryAsset,
    onError: setDirectoryImportError,
    t,
  });
  const isMyAssets = mainTab === '我的素材';
  const isSequences = mainTab === '序列';
  const sequenceOptions = useMemo(() => isSequences ? getSequenceOptions() : [], [isSequences, getSequenceOptions]);

  return (
    <section className="cc-library-panel cc-library-workspace">
      {quickStart && quickStartVisible && <QuickStartGuide intent={quickStart}
        onImport={() => { setExtensionOpen(false); setActiveTool('我的素材'); setMainTab('我的素材'); setQuickImportRequested(true); }}
        onPaste={() => { setExtensionOpen(false); setActiveTool('字幕'); setMainTab('字幕'); onRequestPasteTranscript?.(); }}
        onDismiss={() => setQuickStartVisible(false)} />}
      <div className="cc-library-workbench">
      <LibraryNavigation active={extensionOpen ? '扩展中心' : activeTool}
        onSelect={(tab) => {
          setActiveTool(tab);
          setExtensionOpen(tab === '扩展中心');
          if (isResourceTool(tab)) { setMainTab('资源库'); }
          else if (tab !== '扩展中心') setMainTab(tab);
        }} />
      <div className="cc-library-content">
      {extensionOpen ? (
        <ExtensionCenter onClose={() => setExtensionOpen(false)} />
      ) : mainTab === '字幕' ? (
        <div className="cc-left-captions-workbench" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div className="cc-library-heading" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>{t('字幕与文字')}</span>
            <button type="button" className="cc-cap-btn primary sm" onClick={onAddText}>
              {t('＋ 插入普通文本')}
            </button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            <CaptionsPanel
              mode="generate-only"
              projectId={semanticScopeId}
              timelineId={timelineId}
              draftKey={scopeIdentity}
              key={`left:${scopeIdentity}`}
              playerRef={playerRef}
              fps={fps}
              items={items}
              trackOptions={trackOptions}
              selectedItem={selectedItem}
              captionTracks={captionTracks}
              selectedCaptions={selectedCaptions}
              onSelectCaption={onSelectCaption}
              onSelectCaptionRange={onSelectCaptionRange}
              onSeekFrame={onSeekFrame}
              onSetCaptions={onSetCaptions}
              onUpdateCaptions={onUpdateCaptions}
              onCreateCaptionTrack={onCreateCaptionTrack}
              openPasteTranscriptRequest={pasteTranscriptRequest}
              onCaptionsReady={() => onOpenTextWorkspace?.('字幕')}
            />
          </div>
        </div>
      ) : mainTab === '特效' ? (
        <>
          <div className="cc-library-heading">{t('特效与画面包装')}</div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
            <EffectsBrowser
              selectedItem={selectedItem}
              templates={templates}
              onAddTemplate={onAddTemplate}
              onAddSolid={onAddSolid}
              onAddShape={onAddShape}
              onAddMosaic={onAddMosaic}
              onApplyFx={onApplyFx}
              onApplyTransition={onApplyTransition}
              onApplyZoom={onApplyZoom}
            />
          </div>
        </>
      ) : isSequences ? (
        <div className="cc-sequence-panel">
          {sequenceOptions.length === 0 && (
            <div className="cc-sequence-hint">
              {t('右键多选片段可创建子草稿')}
            </div>
          )}
          <div className="cc-sequence-list">
            {sequenceOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={!!option.disabledReason}
                title={option.disabledReason}
                onClick={() => onAddSequence(option.id)}
                className="cc-sequence-row"
              >
                <span className="cc-sequence-name">{localizeDefaultSequenceName(option.name, t)}</span>
                <span className="cc-sequence-duration">{(option.durationInFrames / fps).toFixed(1)}s</span>
              </button>
            ))}
          </div>
        </div>
      ) : isMyAssets ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, borderTop: `0.5px solid ${theme.border}` }}>
          <MediaPoolPanel importRequested={quickImportRequested} onImportRequestHandled={() => setQuickImportRequested(false)} semanticScopeId={semanticScopeId} assets={assets} folders={mediaFolders} fps={fps} usedAssetIds={usedAssetIds} onTimelineAssetIds={onTimelineAssetIds} previewAssetId={previewAssetId} onPreviewAsset={onPreviewAsset} offlineAssetIds={offlineAssetIds} onAssetLoadError={onAssetLoadError} onImport={onImportMedia} onImportMobile={onImportMobileMedia} directoryImport={directoryImport} directoryImportError={directoryImportError} onAddAsset={onAddMediaItem} onAddAssetsToTimeline={(selectedAssets, sourceRanges) => onAddMediaAssetsToTimeline(selectedAssets, { sourceRanges })}
            onCreateFolder={onCreateMediaFolder} onRenameFolder={onRenameMediaFolder} onDeleteFolder={onDeleteMediaFolder}
            onMoveAssets={onMoveMediaAssets} onRenameAsset={onRenameMediaAsset} onTranscribe={onTranscribeAsset} onRenameAssets={onRenameMediaAssets} onSetFavorite={onSetMediaAssetFavorite} onSetAssetsFavorite={onSetMediaAssetsFavorite} onRemoveAsset={onRemoveMediaAsset} onRemoveAssets={onRemoveMediaAssets} onPasteAssets={onPasteMediaAssets}
            onRelinkAsset={onRelinkMediaAsset} />
        </div>
      ) : (
      <>
      <div className="cc-library-heading">{t('音效')}</div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
        <SoundBrowser fps={fps} onAdd={onAddAudio} onAuditionStart={() => playerRef.current?.pause()} />
      </div>
      </>
      )}
      </div>
      </div>
    </section>
  );
});
