import { Suspense, useEffect, useRef, useState, type ComponentProps } from 'react';
import { theme } from '../theme';
import { TopBar } from '../components/TopBar';
import { ExternalControlHost } from '../components/ExternalControlHost';
import { LibraryPanel } from '../library/LibraryPanel';
import { PreviewPanel } from '../components/PreviewPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { PreviewWorkspace } from '../components/preview/PreviewWorkspace';
import type { TextWorkspacePage } from '../library/TextWorkspace';
import { captionSelectionKey, type CaptionSelectionRef } from '../captions/captionSelection';
import { Timeline } from '../components/timeline/Timeline';
import { TimelineTabs } from '../components/timeline/TimelineTabs';
import { Divider } from '../components/Divider';
import { AppToastHost } from '../ui/AppToastHost';
import { FontLibraryProvider } from '../fonts/FontLibraryProvider';
import './editor-ui-polish.css';
// Opened on demand, so they load on demand — see workspaceDialogs.tsx.
import {
  DesignStylePanel, ExportDialog, SettingsDialog, ShortcutsDialog, VersionHistory,
} from './workspaceDialogs';
import { useWorkspaceDialogPrefetch } from './workspaceDialogLoaders';

export interface EditorWorkspaceViewProps {
  fontLibrary?: Omit<ComponentProps<typeof FontLibraryProvider>, 'children'>;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  librarySize: ComponentProps<typeof Divider>['ariaValue'];
  timelineSize: ComponentProps<typeof Divider>['ariaValue'];
  topBar: ComponentProps<typeof TopBar>;
  exportDialog: ComponentProps<typeof ExportDialog> | null;
  designStylePanel: ComponentProps<typeof DesignStylePanel> | null;
  versionHistory: ComponentProps<typeof VersionHistory> | null;
  shortcutsDialog: ComponentProps<typeof ShortcutsDialog> | null;
  settingsDialog: ComponentProps<typeof SettingsDialog> | null;
  externalControl: ComponentProps<typeof ExternalControlHost>;
  libraryPanel: ComponentProps<typeof LibraryPanel>;
  onResizeLibrary: ComponentProps<typeof Divider>['onResize'];
  onResizeLibraryStart: ComponentProps<typeof Divider>['onResizeStart'];
  onResizeLibraryCancel: ComponentProps<typeof Divider>['onResizeCancel'];
  onResetLibrarySize: ComponentProps<typeof Divider>['onReset'];
  previewPanel: ComponentProps<typeof PreviewPanel>;
  inspectorPanel: ComponentProps<typeof InspectorPanel> | null;
  mosaicFocusRequest?: { itemId: string; effectId: string; nonce: number } | null;
  onResizeTimeline: ComponentProps<typeof Divider>['onResize'];
  onResizeTimelineStart: ComponentProps<typeof Divider>['onResizeStart'];
  onResizeTimelineCancel: ComponentProps<typeof Divider>['onResizeCancel'];
  onResetTimelineSize: ComponentProps<typeof Divider>['onReset'];
  timelineTabs: ComponentProps<typeof TimelineTabs>;
  timeline: ComponentProps<typeof Timeline>;
}

type RightPanelMode = 'inspector' | 'text';

function useRightPanelRouting(props: EditorWorkspaceViewProps) {
  const [mode, setMode] = useState<RightPanelMode>(props.libraryPanel.quickStart === 'captions' ? 'text' : 'inspector');
  const [page, setPage] = useState<TextWorkspacePage>('字幕');
  const [pasteRequest, setPasteRequest] = useState(props.libraryPanel.quickStart === 'captions' ? 1 : props.libraryPanel.pasteTranscriptRequest ?? 0);
  const lastPasteRequest = useRef(props.libraryPanel.pasteTranscriptRequest ?? 0);
  const workspaceIdentity = `${props.libraryPanel.semanticScopeId}:${props.libraryPanel.timelineId}`;
  const [captionActivationRequest, setCaptionActivationRequest] = useState<{
    selection: CaptionSelectionRef; nonce: number; identity: string;
  }>();
  const activationNonce = useRef(0);
  const previousWorkspaceIdentity = useRef(workspaceIdentity);
  const selectedCaptionKey = captionSelectionKey(props.libraryPanel.selectedCaptions?.at(-1) ?? null);
  const selectedItemId = props.libraryPanel.selectedItem?.id ?? null;

  useEffect(() => {
    if (!selectedCaptionKey) return;
    setMode('text');
    setPage('字幕');
  }, [selectedCaptionKey]);
  useEffect(() => {
    if (!selectedItemId) return;
    setMode('inspector');
  }, [selectedItemId]);
  useEffect(() => {
    const request = props.libraryPanel.pasteTranscriptRequest ?? 0;
    if (request === lastPasteRequest.current) return;
    lastPasteRequest.current = request;
    setMode('text');
    setPage('字幕');
    setPasteRequest((current) => current + 1);
  }, [props.libraryPanel.pasteTranscriptRequest]);
  useEffect(() => {
    if (previousWorkspaceIdentity.current === workspaceIdentity) return;
    previousWorkspaceIdentity.current = workspaceIdentity;
    setCaptionActivationRequest(undefined);
  }, [workspaceIdentity]);
  useEffect(() => {
    const request = captionActivationRequest;
    if (!request || request.identity !== workspaceIdentity) return;
    setMode('text');
    setPage('字幕');
  }, [captionActivationRequest?.nonce, workspaceIdentity]);
  const activateCaption = (selection: CaptionSelectionRef) => {
    setPage('字幕');
    setMode('text');
    setCaptionActivationRequest({ selection, nonce: ++activationNonce.current, identity: workspaceIdentity });
  };
  return { mode, setMode, page, setPage, pasteRequest, captionActivationRequest, activateCaption };
}


function renderLibrary(props: EditorWorkspaceViewProps, rightPanel: ReturnType<typeof useRightPanelRouting>) {
  return (
    <div className="cc-editor-library-column" style={{ gridColumn: 1, gridRow: 2, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <LibraryPanel {...props.libraryPanel} textWorkspaceActive={rightPanel.mode === 'text'}
        onOpenTextWorkspace={(page) => {
          const selected = props.libraryPanel.selectedCaptions?.at(-1);
          if (page === '字幕' && selected) rightPanel.activateCaption(selected);
          else { rightPanel.setPage(page); rightPanel.setMode('text'); }
        }} />
    </div>
  );
}

function renderPreview(props: EditorWorkspaceViewProps, rightPanel: ReturnType<typeof useRightPanelRouting>, timelineScrubbing: boolean) {
  const previewProps: ComponentProps<typeof PreviewPanel> = {
    ...props.previewPanel,
    timelineScrubbing,
    onSelectCaption: props.previewPanel.onSelectCaption
      ? (selection) => {
          props.previewPanel.onSelectCaption?.(selection);
          if (selection) {
            rightPanel.setPage('字幕');
            rightPanel.setMode('text');
          }
        }
      : undefined,
  };
  return (
    <div className="cc-editor-preview-column" style={{ gridColumn: 3, gridRow: 2 }}>
      <PreviewWorkspace preview={previewProps} inspector={props.inspectorPanel}
        text={{ ...props.libraryPanel, page: rightPanel.page, onPageChange: rightPanel.setPage,
          onClose: () => rightPanel.setMode('inspector'), pasteTranscriptRequest: rightPanel.pasteRequest,
          captionActivationRequest: rightPanel.captionActivationRequest }}
        textVisible={rightPanel.mode === 'text'}
        onRightModeChange={rightPanel.setMode}
        mosaicFocusRequest={props.mosaicFocusRequest} />
      <ExternalControlHost {...props.externalControl} />
    </div>
  );
}

function renderTimeline(props: EditorWorkspaceViewProps, rightPanel: ReturnType<typeof useRightPanelRouting>, onScrubActiveChange: (active: boolean) => void) {
  const openCaptions = () => { rightPanel.setPage('字幕'); rightPanel.setMode('text'); };
  const review = props.timeline.state.legacyTimingReview;
  const affectedItems = review?.required
    ? props.timeline.state.items
        .filter((it) => review.affectedItemIds.includes(it.id))
        .sort((a, b) => a.startFrame - b.startFrame)
    : [];
  const jumpToNextReviewItem = () => {
    if (!affectedItems.length) return;
    const curIdx = affectedItems.findIndex((it) => it.id === props.timeline.state.selectedId);
    const next = affectedItems[(curIdx + 1) % affectedItems.length] ?? affectedItems[0]!;
    props.timeline.commands.selectItem(next.id);
    props.previewPanel.onSeek?.(next.startFrame);
  };
  return (
    <div
      className="cc-editor-timeline-column"
      style={{ gridColumn: '1 / -1', gridRow: 4, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
      onPointerDownCapture={() => {
        if (props.previewPanel.previewAsset) props.previewPanel.onClosePreviewAsset?.();
      }}
    >
      {review?.required && affectedItems.length > 0 && (
        <div className="cc-legacy-review-banner" role="status">
          <span>⚠ {review.summary}</span>
          <div className="cc-legacy-review-actions">
            <button type="button" onClick={jumpToNextReviewItem}>定位下一处待确认切点（{affectedItems.length}）</button>
            <button type="button" onClick={() => props.timeline.commands.dismissLegacyTimingReview()}>全部确认无误</button>
          </div>
        </div>
      )}
      <Timeline {...props.timeline} onScrubActiveChange={(active) => {
        if (active && props.previewPanel.previewAsset) props.previewPanel.onClosePreviewAsset?.();
        onScrubActiveChange(active);
      }}
        headerLeading={<TimelineTabs {...props.timelineTabs} />} onSelectCaption={(selection, options) => {
        props.timeline.onSelectCaption?.(selection, options);
        if (selection) openCaptions();
      }} onMarqueeCaptionSelect={(selections, options) => {
        props.timeline.onMarqueeCaptionSelect?.(selections, options);
        if (selections.length) rightPanel.activateCaption(selections.at(-1)!);
      }} onActivateCaptionWorkspace={rightPanel.activateCaption} />
    </div>
  );
}

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  useWorkspaceDialogPrefetch();
  const rightPanel = useRightPanelRouting(props);
  const [timelineScrubbing, setTimelineScrubbing] = useState(false);
  const content = (
    <div
      className="cc-editor-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: props.gridTemplateColumns,
        gridTemplateRows: props.gridTemplateRows,
        height: '100vh',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
        fontFamily: 'var(--cc-ui-font)',
      }}
    >
      <TopBar {...props.topBar} />
      {/* No fallback: an overlay that is still loading shows nothing, exactly as
          it did before it was opened. The idle prefetch keeps that window tiny. */}
      <Suspense fallback={null}>
        {props.exportDialog && <ExportDialog {...props.exportDialog} />}
        {props.settingsDialog && <SettingsDialog {...props.settingsDialog} />}
        {props.designStylePanel && <DesignStylePanel {...props.designStylePanel} />}
        {props.versionHistory && <VersionHistory {...props.versionHistory} />}
        {props.shortcutsDialog && <ShortcutsDialog {...props.shortcutsDialog} />}
      </Suspense>
      {renderLibrary(props, rightPanel)}
      <div style={{ gridColumn: 2, gridRow: 2, position: 'relative', zIndex: 25 }}>
        <Divider ariaValue={props.librarySize} ariaValueLabel="媒体库宽度" onResize={props.onResizeLibrary} onResizeStart={props.onResizeLibraryStart} onResizeCancel={props.onResizeLibraryCancel} onReset={props.onResetLibrarySize} />
      </div>
      {renderPreview(props, rightPanel, timelineScrubbing)}
      <div style={{ gridColumn: '1 / -1', gridRow: 3, position: 'relative', zIndex: 25 }}>
        <Divider orientation="horizontal" ariaValue={props.timelineSize} ariaValueLabel="时间线高度" onResize={props.onResizeTimeline} onResizeStart={props.onResizeTimelineStart} onResizeCancel={props.onResizeTimelineCancel} onReset={props.onResetTimelineSize} />
      </div>
      {renderTimeline(props, rightPanel, setTimelineScrubbing)}
      <AppToastHost />
    </div>
  );
  return props.fontLibrary ? <FontLibraryProvider {...props.fontLibrary}>{content}</FontLibraryProvider> : content;
}
