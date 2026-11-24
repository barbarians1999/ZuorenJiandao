import { useEffect, useMemo, useRef, useState } from 'react';
import type { CaptionsData } from './types';
import type { TimelineItem, TrackId } from '../editor/types';
import type { TranscriptVariant } from '../transcript/types';
import { CaptionCueEditor } from './CaptionCueEditor';
import { isTranslationStale } from './translate';
import { useT } from '../i18n/locale';
import { ManualCaptionEditor } from './ManualCaptionEditor';
import { CaptionFontPicker } from './CaptionFontPicker';
import type { CaptionSelectOptions, CaptionSelectionRef } from './captionSelection';

interface CaptionsControlsProps {
  projectId?: string;
  timelineId?: string;
  captionTrackId?: TrackId;
  draftKey?: string;
  captions: CaptionsData | null;
  /** translation / correction variants of the caption's source transcript (main-line language picker) */
  sourceVariants?: TranscriptVariant[];
  /** The sentence-by-sentence editing list needs to recalculate the same paging as the rendering layer, which requires timeline items + fps */
  items: TimelineItem[];
  fps: number;
  showList?: boolean;
  showStyleDetails?: boolean;
  playheadMs?: number;
  playing?: boolean;
  selectedCaptions?: readonly CaptionSelectionRef[];
  captionActivationRequest?: { selection: CaptionSelectionRef; nonce: number };
  onCaptionActivationConsumed?: (nonce: number) => void;
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onSelectCaptionRange?: (selections: CaptionSelectionRef[], options: { additive: boolean; preserveWithItems: boolean }) => void;
  reviewRequest?: { ms: number; serial: number };
  /** Sentence-by-sentence editing: click-to-sentence preview (timeline ms) */
  onSeekMs?: (ms: number) => void;
  onCreateManual: () => void;
  focusManualLane?: string | null;
  onManualFocused?: () => void;
  getPlayheadMs?: () => number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  onLiveUpdate?: (patch: Partial<CaptionsData> | null) => void;
  /** Completely remove captions (hide and clear overlay status) */
  onRemove?: () => void;
}

// Independent caption workspace: style, rhythm, manual captions and translation are all edited here.
export function CaptionsControls({
  projectId, timelineId, captionTrackId, draftKey, captions, sourceVariants = [], items, fps, reviewRequest, onSeekMs, onCreateManual, focusManualLane, onManualFocused, getPlayheadMs, onUpdate, onLiveUpdate,
  showList = true, showStyleDetails = true, playheadMs, playing, selectedCaptions, captionActivationRequest, onCaptionActivationConsumed,
  onSelectCaption, onSelectCaptionRange,
}: CaptionsControlsProps) {
  const t = useT();
  const [optionsOpen, setOptionsOpen] = useState(!showList);
  const lastShowList = useRef(showList);
  useEffect(() => {
    if (lastShowList.current !== showList) setOptionsOpen(!showList);
    if (focusManualLane) setOptionsOpen(true);
    lastShowList.current = showList;
  }, [showList, focusManualLane]);
  // Translation cues carry absolute timeline ms; re-timing the source leaves
  // them pinned to the old positions, so say so rather than showing drift.
  const translationStale = useMemo(
    () => (captions ? isTranslationStale(captions, items, fps) : false),
    [captions, items, fps],
  );

  return (
    <div className="cc-cap-panel open standalone">
      {!captions && (
        <div className="cc-cap-empty">
          <div className="cc-cap-empty-actions">
            <button type="button" className="cc-cap-btn primary" onClick={onCreateManual}>{t('手动添加字幕')}</button>
          </div>
        </div>
      )}

      {captions && (
        <div className="cc-cap-body">
          {!captions.enabled && (
            <div className="cc-cap-row main">
              <p className="cc-cap-hint warn" style={{ margin: 0, flex: 1 }}>
                {t('字幕已关闭，预览/导出都不会烧录。')}
              </p>
              <button type="button" className="cc-cap-btn sm" onClick={() => onUpdate({ enabled: true })}>
                {t('恢复显示')}
              </button>
            </div>
          )}

          {showList && <CaptionCueEditor projectId={projectId} timelineId={timelineId} captionTrackId={captionTrackId} draftKey={draftKey} captions={captions} items={items} fps={fps} reviewRequest={reviewRequest}
            playheadMs={playheadMs} playing={playing} selectedCaptions={selectedCaptions} captionActivationRequest={captionActivationRequest}
            onCaptionActivationConsumed={onCaptionActivationConsumed} onSelectCaption={onSelectCaption}
            onSelectCaptionRange={onSelectCaptionRange} onUpdate={onUpdate} onLiveUpdate={onLiveUpdate} onSeekMs={onSeekMs} />}

          {showStyleDetails && <details className="cc-caption-list-options" open={optionsOpen} onToggle={(event) => {
            if (event.target === event.currentTarget) setOptionsOpen(event.currentTarget.open);
          }}>
          <summary>{t('字幕样式与手动添加')}</summary>

          <CaptionFontPicker captions={captions} onUpdate={onUpdate} />


          {/* caption language (text variant): Change the main caption line to a translation/correction variant, leaving the timeline unchanged.
Variants are generated by Agent's manage_transcript translate. Here you only select which one to display.*/}
          {sourceVariants.length > 0 && (
            <div className="cc-cap-field">
              <div className="cc-cap-label">{t('字幕语言（文本变体）')}</div>
              <select
                value={captions.captionVariantId ?? ''}
                onChange={(e) => onUpdate({ captionVariantId: e.target.value || undefined })}
                className="cc-cap-select"
              >
                <option value="">{t('原文（source）')}</option>
                {sourceVariants.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
          )}

          {captions.translation && <div className="cc-cap-bilingual">
            <label className="cc-cap-toggle">
              <input type="checkbox" checked={!!captions.bilingual} onChange={(event) => onUpdate({ bilingual: event.target.checked })} />
              <span>{t('显示已有双语第二行')} ({captions.translationLang})</span>
            </label>
            {translationStale && <div className="cc-cap-hint warn">{t('原文时间已改变，请重新校对已有翻译时间。')}</div>}
          </div>}
          <ManualCaptionEditor captions={captions} items={items} fps={fps} onUpdate={onUpdate} getPlayheadMs={getPlayheadMs} onSeekMs={onSeekMs} focusManualLane={optionsOpen ? focusManualLane : null} onManualFocused={onManualFocused} showCueList={false} showSrtImport={false} />
          </details>}

        </div>
      )}
    </div>
  );
}
