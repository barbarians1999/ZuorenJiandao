import { type FocusEvent, useState } from 'react';
import {
  canAdjustItemSpeed,
  fillToNextFailureMessage,
  formatSpeedSeconds,
  planSpeedForTargetSeconds,
  type FillToNextPlan,
} from '../../editor/speedDuration';
import type { TimelineItem } from '../../editor/types';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';

const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

function SpeedMenu({
  item,
  rate,
  fps,
  canSpeed,
  fillPlan,
  onChange,
  onDurationChange,
  onFillToNext,
}: {
  item: TimelineItem;
  rate: number;
  fps: number;
  canSpeed: boolean;
  fillPlan?: FillToNextPlan | null;
  onChange: (rate: number) => void;
  onDurationChange?: (targetSeconds: number) => void;
  onFillToNext?: () => void;
}) {
  const t = useT();
  const safeFps = Math.max(1, fps);
  const currentSeconds = formatSpeedSeconds(item.durationInFrames / safeFps);
  const syncKey = `${item.id}:${currentSeconds}`;
  const [draftState, setDraftState] = useState<{ key: string; value: string }>(() => ({
    key: syncKey,
    value: currentSeconds,
  }));
  const durationDraft = draftState.key === syncKey ? draftState.value : currentSeconds;
  const setDurationDraft = (value: string) => setDraftState({ key: syncKey, value });

  const parsedSeconds = Number(durationDraft.trim());
  const validDraft = durationDraft.trim().length > 0 && Number.isFinite(parsedSeconds) && parsedSeconds > 0;
  const previewPlan = validDraft ? planSpeedForTargetSeconds(item, parsedSeconds, safeFps) : null;
  const isVideoTrack = (fillPlan?.trackKind ?? 'video') !== 'audio';
  const fillLabel = isVideoTrack ? t('填充至后一视频单元') : t('填充至同轨后一片段');
  const fillDisabledReason = fillPlan && !fillPlan.ok
    ? t(fillToNextFailureMessage(fillPlan.reason, fillPlan.trackKind))
    : undefined;

  return (
    <div data-testid="timeline-speed-menu" style={{
      position: 'absolute', top: 30, left: 0, zIndex: 30, width: 252,
      padding: 10, background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
      borderRadius: 6, boxShadow: `0 10px 28px ${themeAlpha.shadow(0.32)}`,
    }}>
      <div style={{ color: theme.text, fontSize: 12, fontWeight: 650, marginBottom: 8 }}>{t('变速')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
        {SPEED_PRESETS.map((preset) => {
          const active = Math.abs(rate - preset) < 0.01;
          return (
            <button key={preset} type="button" disabled={!canSpeed} onClick={() => onChange(preset)}
              style={{
                height: 28, border: `0.5px solid ${active ? theme.accent : theme.border}`,
                borderRadius: 4, background: active ? theme.hover : theme.panel,
                color: active ? theme.textStrong : theme.textMuted,
                cursor: canSpeed ? 'pointer' : 'not-allowed', opacity: canSpeed ? 1 : 0.45,
                fontSize: 11, fontWeight: active ? 700 : 500,
              }}>
              {preset}×
            </button>
          );
        })}
      </div>
      {onDurationChange && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `0.5px solid ${theme.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: theme.textMuted, fontSize: 11, flexShrink: 0 }}>{t('变速成')}</span>
            <input
              data-testid="timeline-speed-duration-input"
              type="number"
              min={0.05}
              step={0.1}
              disabled={!canSpeed}
              value={durationDraft}
              aria-label={t('目标时长（秒）')}
              style={{
                width: 68, height: 26, padding: '0 6px',
                border: `0.5px solid ${theme.border}`, borderRadius: 4,
                background: theme.bg, color: theme.text,
                fontSize: 11, fontVariantNumeric: 'tabular-nums', textAlign: 'right',
              }}
              onChange={(event) => setDurationDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter' && canSpeed && validDraft) {
                  event.preventDefault();
                  onDurationChange(parsedSeconds);
                }
              }}
            />
            <span style={{ color: theme.textDim, fontSize: 11 }}>{t('秒')}</span>
            <button
              type="button"
              data-testid="timeline-speed-duration-apply"
              disabled={!canSpeed || !validDraft}
              onClick={() => { if (canSpeed && validDraft) onDurationChange(parsedSeconds); }}
              style={{
                marginLeft: 'auto', height: 26, padding: '0 9px',
                border: `0.5px solid ${theme.border}`, borderRadius: 4,
                background: theme.panel, color: theme.text,
                cursor: canSpeed && validDraft ? 'pointer' : 'not-allowed',
                opacity: canSpeed && validDraft ? 1 : 0.45, fontSize: 11,
              }}
            >
              {t('应用')}
            </button>
          </div>
          {canSpeed && previewPlan && Math.abs(parsedSeconds - item.durationInFrames / safeFps) >= 0.005 && (
            <div style={{ color: theme.textDim, fontSize: 10, marginTop: 4 }}>
              {previewPlan.clamped
                ? t('将按 {rate}× 调整为 {sec} 秒', {
                    rate: Number(previewPlan.rate.toFixed(2)),
                    sec: formatSpeedSeconds(previewPlan.resultingFrames / safeFps),
                  })
                : t('将变速为 {rate}×', { rate: Number(previewPlan.rate.toFixed(2)) })}
            </div>
          )}
        </div>
      )}
      {onFillToNext && fillPlan && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `0.5px solid ${theme.border}` }}>
          <button
            type="button"
            data-testid="timeline-speed-fill-next"
            disabled={!canSpeed || !fillPlan.ok}
            title={fillDisabledReason}
            onClick={() => { if (canSpeed && fillPlan.ok) onFillToNext(); }}
            style={{
              width: '100%', height: 28, padding: '0 8px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              border: `0.5px solid ${theme.border}`, borderRadius: 4,
              background: theme.panel, color: theme.text,
              cursor: canSpeed && fillPlan.ok ? 'pointer' : 'not-allowed',
              opacity: canSpeed && fillPlan.ok ? 1 : 0.45, fontSize: 11,
            }}
          >
            <Icon name="rateStretch" size={12} />
            <span>{fillLabel}</span>
          </button>
          <div style={{ color: theme.textDim, fontSize: 10, lineHeight: 1.4, marginTop: 4 }}>
            {fillPlan.ok
              ? (fillPlan.remainingGapFrames > 0
                  ? t('将按最慢 0.10× 拉长至 {result} 秒（仍余 {rem} 秒空隙）', {
                      result: formatSpeedSeconds(fillPlan.resultingFrames / safeFps),
                      rem: formatSpeedSeconds(fillPlan.remainingGapFrames / safeFps),
                    })
                  : t('补齐 {gap} 秒空隙 → {target} 秒（{rate}×）', {
                      gap: formatSpeedSeconds(fillPlan.gapFrames / safeFps),
                      target: formatSpeedSeconds(fillPlan.resultingFrames / safeFps),
                      rate: Number(fillPlan.rate.toFixed(2)),
                    }))
              : fillDisabledReason}
          </div>
        </div>
      )}
      <div style={{ color: theme.textDim, fontSize: 10, lineHeight: 1.45, marginTop: 8 }}>
        {canSpeed
          ? t('保调变速（预览/导出）· 时长随速率伸缩并波纹合缝')
          : t('当前片段已启用逐字编辑，暂不支持变速')}
      </div>
    </div>
  );
}

export function TimelineSpeedControl({
  item,
  fps = 30,
  fillPlan,
  onChange,
  onDurationChange,
  onFillToNext,
}: {
  item: TimelineItem | null;
  fps?: number;
  fillPlan?: FillToNextPlan | null;
  onChange: (rate: number) => void;
  onDurationChange?: (targetSeconds: number) => void;
  onFillToNext?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const canSpeed = !!item && canAdjustItemSpeed(item);
  const rate = item?.playbackRate ?? 1;
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  const applyRate = (nextRate: number) => {
    onChange(nextRate);
    setOpen(false);
  };
  const applyDuration = (targetSeconds: number) => {
    onDurationChange?.(targetSeconds);
    setOpen(false);
  };
  const applyFillToNext = () => {
    onFillToNext?.();
    setOpen(false);
  };

  return (
    <div data-testid="timeline-speed-control" onBlur={handleBlur} style={{ position: 'relative', flexShrink: 0 }}>
      <button type="button" disabled={!item} aria-expanded={open} aria-label={t('变速')}
        className="cc-tip" data-tip={t('变速')} onClick={() => setOpen((value) => !value)}
        style={{
          height: 24, minWidth: 45, padding: '0 6px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          border: `0.5px solid ${open ? theme.accent : theme.border}`, borderRadius: 4,
          color: item ? theme.textMuted : theme.textDim, background: open ? theme.hover : 'transparent',
          cursor: item ? 'pointer' : 'default', opacity: item ? 1 : 0.4,
          fontSize: 11, fontVariantNumeric: 'tabular-nums',
        }}>
        <Icon name="clock" size={14} />
        <span>{Number(rate.toFixed(3))}×</span>
        <Icon name="chevronDown" size={11} />
      </button>
      {open && item && (
        <SpeedMenu
          item={item}
          rate={rate}
          fps={fps}
          canSpeed={canSpeed}
          fillPlan={fillPlan}
          onChange={applyRate}
          onDurationChange={onDurationChange ? applyDuration : undefined}
          onFillToNext={onFillToNext ? applyFillToNext : undefined}
        />
      )}
    </div>
  );
}
