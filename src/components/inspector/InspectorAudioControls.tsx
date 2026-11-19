import type { TimelineItem } from '../../editor/types';
import { inspectorMixedValue } from '../../editor/inspectorBatch';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { TrackAudioControl } from '../audio/TrackAudioControl';
import { VolumeControl } from './InspectorKeyframeControls';
import { FadeControl, IsolateVoiceControl, TransitionControl } from './InspectorMediaControls';
import type { InspectorPanelProps } from './InspectorTypes';

interface InspectorAudioControlsProps {
  panel: InspectorPanelProps;
  item: TimelineItem;
  playheadLocal: { localFrame: number; inRange: boolean };
}

/** Clip controls stay separate from the explicitly track-wide music settings. */
export function InspectorAudioControls({ panel, item, playheadLocal }: InspectorAudioControlsProps) {
  const t = useT();
  const selection = panel.selectedItems.length ? panel.selectedItems : [item];
  const mixed = <T,>(read: (entry: TimelineItem) => T) => inspectorMixedValue(selection, read).mixed;
  const audioOnly = selection.every((entry) => entry.kind === 'audio');
  const videoOnly = selection.every((entry) => entry.kind === 'video');
  const fadeMixed = mixed((entry) => [entry.fadeInFrames ?? 0, entry.fadeOutFrames ?? 0]);
  const tracks = panel.audioTracks ?? [];
  return <div className="cc-practical-audio" style={{ fontSize: 14, display: 'grid', gap: 12 }}>
    <div>
      <div className="cc-insp-section"><span>{t('片段音量')}</span></div>
      <VolumeControl item={item} mixed={mixed((entry) => entry.volume ?? 1)}
        onChange={panel.onItemVolumeChange}
        onNormalize={audioOnly ? panel.onNormalizeLoudness : undefined}
        onReset={panel.onResetItemKeyframes} kf={{
          ...playheadLocal,
          set: panel.onSetItemKeyframe,
          remove: panel.onRemoveItemKeyframe,
          seekLocal: (frame) => panel.onSeek(item.startFrame + frame),
        }} />


    </div>
    {(audioOnly || videoOnly) && <div>
      <div className="cc-insp-section">
        <span>{t(audioOnly ? '声音淡入淡出' : '已有片段淡入淡出')}</span>
        <button type="button" className="cc-insp-group-reset" style={{ fontSize: 14 }}
          title={t('重置淡入淡出')}
          disabled={!fadeMixed && (item.fadeInFrames ?? 0) === 0 && (item.fadeOutFrames ?? 0) === 0}
          onClick={() => panel.onItemFadeChange({ fadeInFrames: 0, fadeOutFrames: 0 })}>{t('重置')}</button>
      </div>
      <FadeControl item={item} mixed={{
        fadeInFrames: mixed((entry) => entry.fadeInFrames ?? 0),
        fadeOutFrames: mixed((entry) => entry.fadeOutFrames ?? 0),
      }} fps={panel.fps} onChange={panel.onItemFadeChange} />

    </div>}

    {tracks.length > 0 && panel.onAudioTrackChange && <div>
      <div className="cc-insp-section"><span>{t('人声与配乐')}</span></div>

      {tracks.map((track) => <fieldset key={track.id} style={{ margin: '0 0 10px', padding: 10, border: `1px solid ${theme.border}`, minWidth: 0 }}>
        <legend style={{ padding: '0 5px', fontSize: 14, fontWeight: 700 }}>{track.label}</legend>
        <TrackAudioControl config={track.config} onChange={(patch) => panel.onAudioTrackChange?.(track.id, patch)} />
      </fieldset>)}
    </div>}
    {(audioOnly && selection.length === 1 || panel.onIsolateVoice && selection.length === 1) && <details className="cc-inspector-advanced">
      <summary style={{ fontSize: 14 }}>{t('更多音频处理')}</summary>
      {audioOnly && <>
        <div className="cc-insp-section"><span>{t('音频接缝')}</span></div>
        <TransitionControl transition={panel.transition} fps={panel.fps} onAdd={panel.onAddTransition} onSet={panel.onSetTransition} onRemove={panel.onRemoveTransition} audioMode />
      </>}
      {panel.onIsolateVoice && <>
        <div className="cc-insp-section"><span>{t('人声降噪')}</span></div>
        <IsolateVoiceControl item={item} onIsolate={panel.onIsolateVoice} />
      </>}
    </details>}
  </div>;
}
