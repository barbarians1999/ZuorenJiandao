import { memo, useEffect, useRef, useState } from 'react';
import type { LibraryPanelProps } from './LibraryPanel';
import { CaptionsPanel } from '../captions/CaptionsPanel';
import { useT } from '../i18n/locale';

type LibraryProps = LibraryPanelProps;
export type TextWorkspacePage = '字幕' | '文字稿剪辑';
export type TextWorkspaceProps = Pick<LibraryProps,
  | 'timelineId' | 'semanticScopeId' | 'playerRef' | 'fps' | 'items' | 'trackOptions' | 'captionTracks'
  | 'onSetCaptions' | 'onCreateCaptionTrack' | 'onUpdateCaptions' | 'onLiveUpdateCaptions' | 'selectedCaptions' | 'onSelectCaption'
  | 'onSelectCaptionRange' | 'onSeekFrame' | 'onSetItemTranscript' | 'onToggleWord' | 'onCleanScript' | 'onSetGapCap'
  | 'onSetTranscriptPlayOrder' | 'onReorderTrackItems' | 'onClearEdits' | 'selectedItem' | 'onAddText'
  | 'pasteTranscriptRequest'
> & {
  page: TextWorkspacePage;
  onPageChange: (page: TextWorkspacePage) => void;
  onClose: () => void;
  captionActivationRequest?: { selection: NonNullable<LibraryProps['selectedCaptions']>[number]; nonce: number; identity: string };
  visible?: boolean;
};

export const TextWorkspace = memo(function TextWorkspace({
  timelineId, semanticScopeId, playerRef, fps, items, trackOptions, captionTracks,
  onSetCaptions, onCreateCaptionTrack, onUpdateCaptions, onLiveUpdateCaptions, selectedCaptions, onSelectCaption,
  onSelectCaptionRange, onSeekFrame, selectedItem,
  pasteTranscriptRequest = 0, page, captionActivationRequest, visible = true,
}: TextWorkspaceProps) {
  const t = useT();
  const identity = `${semanticScopeId}:${timelineId}`;
  const previousIdentity = useRef(identity);
  const [activePasteRequest, setActivePasteRequest] = useState(pasteTranscriptRequest);
  const [selectTrackRequest, setSelectTrackRequest] = useState<{ trackId: string; nonce: number; identity: string }>();
  useEffect(() => {
    if (pasteTranscriptRequest > 0) setActivePasteRequest(pasteTranscriptRequest);
  }, [pasteTranscriptRequest]);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    setSelectTrackRequest(undefined);
    setActivePasteRequest(0);
  }, [identity]);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.cc-text-workspace-page[hidden]')) active.blur();
  }, [page]);

  return <section className="cc-text-workspace" aria-label={t('字幕列表')}>
    <div className="cc-text-workspace-body">
      <div className="cc-text-workspace-page">
        <CaptionsPanel mode="list-only" visible={visible} projectId={semanticScopeId} timelineId={timelineId} selectedCaptions={selectedCaptions}
          onSelectCaption={onSelectCaption} onSelectCaptionRange={onSelectCaptionRange} onSeekFrame={onSeekFrame}
          draftKey={`${semanticScopeId}:${timelineId}`} key={`${semanticScopeId}:${timelineId}`} playerRef={playerRef}
          fps={fps} items={items} trackOptions={trackOptions} selectedItem={selectedItem} captionTracks={captionTracks}
          onSetCaptions={onSetCaptions} onUpdateCaptions={onUpdateCaptions} onLiveUpdateCaptions={onLiveUpdateCaptions} onCreateCaptionTrack={onCreateCaptionTrack}
          openPasteTranscriptRequest={activePasteRequest}
          onPasteRequestConsumed={(nonce) => setActivePasteRequest((current) => current === nonce ? 0 : current)}
          selectTrackRequest={selectTrackRequest?.identity === identity ? selectTrackRequest : undefined}
          captionActivationRequest={captionActivationRequest?.identity === identity ? captionActivationRequest : undefined} />
      </div>
    </div>
  </section>;
}, (prev, next) => prev.visible === false && next.visible === false);

