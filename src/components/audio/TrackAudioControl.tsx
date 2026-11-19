import type { TrackFlags, TrackRole, TrackUpdate } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import { SliderRow } from '../inspector/InspectorKeyframeControls';

const ROLE_OPTIONS: ReadonlyArray<{ role: TrackRole | null; label: string; hint: string }> = [
  { role: null, label: '普通音频', hint: '不自动压低其他轨道，也不跟随人声变化。' },
  { role: 'anchor', label: '人声', hint: '人声片段播放时，让配乐轨道降低音量。' },
  { role: 'follower', label: '配乐（说话时压低）', hint: '另一个轨道设为人声后，配乐会在其片段播放时压低。' },
];

const DEPTH_OPTIONS = [
  { db: -6, label: '轻一点' },
  { db: -12, label: '常用' },
  { db: -18, label: '明显' },
  { db: -24, label: '很低' },
] as const;

interface TrackAudioControlProps {
  config: TrackFlags;
  onChange: (patch: TrackUpdate) => void;
  onRoleChosen?: (role: TrackRole | null) => void;
}

/** The inspector and track menu expose the same existing track-mix settings. */
export function TrackAudioControl(props: TrackAudioControlProps) {
  const t = useT();
  return <TrackAudioControlView {...props} translate={t} />;
}

export function TrackAudioControlView({ config, onChange, onRoleChosen, translate: t }: TrackAudioControlProps & {
  translate: (text: string) => string;
}) {
  const currentRole = config.role ?? null;
  const depth = config.audioRouting?.duckDepthDb ?? -12;
  const gainDb = config.audioRouting?.gainDb ?? 0;
  return (
    <div className="cc-track-audio-control" style={{ display: 'grid', gap: 10, fontSize: 14, lineHeight: 1.5 }}>
      <div role="group" aria-label={t('轨道用途')} style={{ display: 'grid', gap: 6 }}>
        {ROLE_OPTIONS.map((option) => <button
          key={option.label}
          type="button"
          className="cc-insp-btn"
          aria-pressed={currentRole === option.role}
          style={{ textAlign: 'left', padding: '8px 10px', fontSize: 14, whiteSpace: 'normal',
            borderColor: currentRole === option.role ? theme.accent : undefined }}
          onClick={() => {
            onChange({ role: option.role });
            onRoleChosen?.(option.role);
          }}
        >
          <strong style={{ display: 'block' }}>{t(option.label)}</strong>
          <span style={{ display: 'block', color: theme.textMuted, fontSize: 14 }}>{t(option.hint)}</span>
        </button>)}
      </div>
      {currentRole === 'follower' && <div>
        <div style={{ marginBottom: 6 }}>{t('配乐压低多少')}</div>
        <div role="group" aria-label={t('配乐压低多少')} style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
          {DEPTH_OPTIONS.map((option) => <button
            key={option.db}
            type="button"
            className="cc-insp-btn"
            aria-pressed={depth === option.db}
            title={`${option.db} dB`}
            style={{ fontSize: 14, padding: '6px 8px' }}
            onClick={() => onChange({ audioRouting: { duckDepthDb: option.db } })}
          >{t(option.label)} · {option.db} dB</button>)}
        </div>
      </div>}
      <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 10 }}>
        <SliderRow
          label={t('整轨音量')}
          val={gainDb}
          min={-60}
          max={12}
          step={1}
          fmt={`${Math.round(gainDb)} dB`}
          onChange={(value) => onChange({ audioRouting: { gainDb: value } })}
          onReset={() => onChange({ audioRouting: { gainDb: null } })}
          resetDisabled={gainDb === 0}
        />
        <div style={{ marginTop: 6, color: theme.textMuted, fontSize: 14 }}>{t('作用于这个轨道的所有片段，不修改源文件。')}</div>
      </div>
    </div>
  );
}
