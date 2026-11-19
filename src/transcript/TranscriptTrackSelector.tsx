import type { TimelineItem, TrackId } from '../editor/types';
import { useT } from '../i18n/locale';
import { isLikelyNonSpeech, mediaOnTrack, type TranscriptTrackOption } from './trackOptions';

interface TranscriptTrackSelectorProps {
  selectable: TranscriptTrackOption[];
  items: TimelineItem[];
  track: TrackId | null;
  onSelectTrack: (track: TrackId) => void;
}

/** Track chips show alias and name, never a bare UUID. */
export function TranscriptTrackSelector({ selectable, items, track, onSelectTrack }: TranscriptTrackSelectorProps) {
  const t = useT();
  return (
      <div className="cc-tx-tracks" role="tablist" aria-label={t('转写轨道')}>
        {selectable.length === 0 ? (
          <span className="cc-tx-muted">{t('时间线上还没有可转写的音视频轨')}</span>
        ) : (
          selectable.map((t) => {
            const n = mediaOnTrack(items, t.id).length;
            const speechN = mediaOnTrack(items, t.id).filter((c) => !isLikelyNonSpeech(c)).length;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={track === t.id}
                className={`cc-tx-track-chip${track === t.id ? ' selected' : ''}`}
                onClick={() => onSelectTrack(t.id)}
                title={t.id}
              >
                <span className="cc-tx-track-alias">{t.alias}</span>
                {t.name ? <span className="cc-tx-track-name">{t.name}</span> : null}
                <span className="cc-tx-track-count">{speechN || n}</span>
              </button>
            );
          })
        )}
      </div>
  );
}
