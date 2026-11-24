import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { TimelineItem } from '../../editor/types';
import { PICTURE_ANIMATIONS, resolvePictureAnimation } from '../../editor/clipAnimation';
import { TITLE_ANIMATIONS, resolveTextStyle } from '../../editor/textStyles';
import { useT } from '../../i18n/locale';
import type { AnimationAuditionPreview } from './useAnimationAudition';
import { useHistoryGesture } from './historyGesture';
import { useInspectorWheel } from './useInspectorWheel';
import './picture-animation.css';

const GROUPS = ['全部', '常用', '位移', '缩放', '旋转与柔焦'] as const;
function groupFor(id: string): typeof GROUPS[number] {
  if (['fade', 'whip', 'whip-left', 'whip-up', 'whip-down', 'pop'].includes(id)) return '常用';
  if (id.startsWith('push') || id.startsWith('slide')) return '位移';
  if (id.startsWith('zoom')) return '缩放';
  return '旋转与柔焦';
}

export function PictureAnimationControl({ item, mixed, fps, onChange }: {
  item: TimelineItem;
  mixed: (key: string) => boolean;
  fps: number;
  onChange: (key: string, value: unknown) => void;
  preview?: AnimationAuditionPreview;
}) {
  const t = useT();
  const [side, setSide] = useState<'entrance' | 'exit'>('entrance');
  const [group, setGroup] = useState<typeof GROUPS[number]>('全部');
  const gesture = useHistoryGesture();
  const id = useId();
  const isText = item.kind === 'text';
  const motion = isText ? resolveTextStyle(item.props) : resolvePictureAnimation(item.props);
  const options = isText ? TITLE_ANIMATIONS : PICTURE_ANIMATIONS;
  const key = isText ? side : side === 'entrance' ? 'visualEntrance' : 'visualExit';
  const framesKey = `${key}Frames`;
  const frames = motion[`${side}Frames`];
  const maxFrames = Math.max(1, Math.min(300, item.durationInFrames - 1));
  const durationDisabled = !mixed(key) && motion[side] === 'none';
  const clampedFrames = Math.min(frames, maxFrames);
  const numberRef = useRef<HTMLInputElement>(null);
  useInspectorWheel(numberRef, {
    value: frames / fps,
    min: 1 / fps,
    max: 300 / fps,
    step: 1 / fps,
    disabled: durationDisabled || mixed(framesKey),
    onChange: (seconds) => onChange(framesKey, Math.max(1, Math.min(300, Math.round(seconds * fps)))),
  });
  const current = options.find((option) => option.id === motion[side]);
  const shown = isText || group === '全部' ? options : options.filter((option) => option.id === 'none' || groupFor(option.id) === group);
  const apply = (value: string) => onChange(key, value);
  const changeSide = (next: 'entrance' | 'exit') => setSide(next);
  const labelFor = (label: string) => t(label.split('／')[side === 'entrance' ? 0 : 1] ?? label);
  const selectSide = (tab: 'entrance' | 'exit', event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'entrance' : event.key === 'End' ? 'exit' : tab === 'entrance' ? 'exit' : 'entrance';
    changeSide(next);
    requestAnimationFrame(() => document.getElementById(`${id}-${next}-tab`)?.focus());
  };
  return <div className="cc-clip-animation">
    <div className="cc-animation-tabs" role="tablist" aria-label={t('片段动画')}>
      {(['entrance', 'exit'] as const).map((tab) => <button key={tab} type="button"
        id={`${id}-${tab}-tab`} role="tab" aria-selected={side === tab} tabIndex={side === tab ? 0 : -1}
        aria-controls={`${id}-options`} onKeyDown={(event) => selectSide(tab, event)}
        onClick={() => changeSide(tab)}>{t(tab === 'entrance' ? '入场动画' : '出场动画')}</button>)}
    </div>
    <div id={`${id}-options`} role="tabpanel" aria-labelledby={`${id}-${side}-tab`}>
      <p className="cc-animation-status" role="status">{mixed(key) ? t('所选片段的动画不同')
        : motion[side] === 'none' ? t('当前未添加动画') : t('已应用：{name}', { name: current ? labelFor(current.label) : '' })}</p>
      {!isText && <div className="cc-animation-groups" aria-label={t('动画分类')}>
        {GROUPS.map((entry) => <button type="button" key={entry} aria-pressed={entry === group}
          onClick={() => setGroup(entry)}>{t(entry)}</button>)}
      </div>}
      <div className="cc-animation-cards">
        {shown.map((option) => <button key={option.id} type="button"
          className={`cc-animation-card${!mixed(key) && motion[side] === option.id ? ' selected' : ''}`}
          aria-pressed={!mixed(key) && motion[side] === option.id}
          onClick={() => apply(option.id)}>
          <span className="cc-animation-sample" data-motion={option.id} data-side={side} aria-hidden="true">
            <span className={isText ? undefined : 'cc-animation-picture'}>{isText ? 'Aa' : ''}</span>
          </span>
          <span>{labelFor(option.label)}</span>
        </button>)}
      </div>
      {mixed(key) && <p className="cc-insp-muted">{t('所选片段的动画不同；点击卡片可统一应用。')}</p>}
      <label className="cc-insp-mg-field"><span>{t('动画时长（秒）')}{mixed(framesKey) ? '（不同）' : ''}</span>
        <input type="range" min={1} max={maxFrames} step={1}
          aria-label={t('动画时长')} disabled={durationDisabled}
          value={clampedFrames}
          onChange={(event) => onChange(framesKey, Number(event.target.value))} {...gesture} />
        <input ref={numberRef} type="number" min={1 / fps} max={300 / fps} step={1 / fps}
          disabled={durationDisabled} value={mixed(framesKey) ? '' : frames / fps}
          onChange={(event) => { const seconds = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(seconds)) onChange(framesKey, Math.max(1, Math.min(300, Math.round(seconds * fps)))); }} {...gesture} />
      </label>
    </div>
  </div>;
}
