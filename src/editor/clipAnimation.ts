import type { TimelineItem } from './types';
import { pictureAnimationProgress, pictureAnimationTiming } from '../../shared/picture-animation-timing.mjs';

export const PICTURE_ANIMATIONS = [
  { id: 'none', label: '无' }, { id: 'fade', label: '淡入／淡出' },
  { id: 'push-left', label: '左侧推入／退出' }, { id: 'push-right', label: '右侧推入／退出' },
  { id: 'slide-up', label: '下方滑入／退出' }, { id: 'slide-down', label: '上方滑入／退出' },
  { id: 'zoom', label: '缩放显现／收起' }, { id: 'whip', label: '甩入／甩出' },
  { id: 'zoom-out', label: '拉远显现／放大退出' },
  { id: 'spin-left', label: '左旋入场／左旋退出' }, { id: 'spin-right', label: '右旋入场／右旋退出' },
  { id: 'pop', label: '弹入／弹出' }, { id: 'blur', label: '柔焦显现／柔焦消失' },
  { id: 'whip-left', label: '左甩入／左甩出' },
  { id: 'whip-up', label: '向上甩入／向上甩出' }, { id: 'whip-down', label: '向下甩入／向下甩出' },
] as const;
export type PictureAnimation = typeof PICTURE_ANIMATIONS[number]['id'];

export function animationFrames(value: unknown, fallback = 12): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.max(1, Math.min(300, n))) : fallback;
}

/** Local timeline frames only. One/two-frame clips stay readable. Long motions
 * share the available span proportionally instead of hiding a whole short clip. */
export function animationProgress(frame: number, duration: number, entranceFrames: number, exitFrames: number) {
  const span = Math.max(0, duration - 1);
  if (span < 2) return { entrance: 1, exit: 1 };
  const total = entranceFrames + exitFrames;
  const factor = total > span ? span / total : 1;
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return {
    entrance: entranceFrames > 0 ? clamp(frame / (entranceFrames * factor)) : 1,
    exit: exitFrames > 0 ? clamp((span - frame) / (exitFrames * factor)) : 1,
  };
}

export function resolvePictureAnimation(props: Record<string, unknown> = {}) {
  const kind = (value: unknown): PictureAnimation =>
    PICTURE_ANIMATIONS.find((option) => option.id === value)?.id ?? 'none';
  return {
    entrance: kind(props.visualEntrance), exit: kind(props.visualExit),
    entranceFrames: animationFrames(props.visualEntranceFrames),
    exitFrames: animationFrames(props.visualExitFrames),
  };
}

function motionAt(kind: PictureAnimation, progress: number) {
  const p = Math.max(0, Math.min(1, progress));
  const rest = Math.pow(1 - p, 3);
  const x = kind === 'push-left' || kind === 'whip-left' ? -100 * rest : kind === 'push-right' || kind === 'whip' ? 100 * rest : 0;
  const y = kind === 'slide-up' || kind === 'whip-up' ? 100 * rest : kind === 'slide-down' || kind === 'whip-down' ? -100 * rest : 0;
  const rotation = kind === 'whip' ? 12 * rest : kind === 'whip-left' ? -12 * rest
    : kind === 'whip-up' ? -12 * rest : kind === 'whip-down' ? 12 * rest
    : kind === 'spin-left' ? -90 * rest : kind === 'spin-right' ? 90 * rest : 0;
  const pop = 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
  const scale = kind === 'zoom' ? 1 - rest * 0.18 : kind === 'zoom-out' ? 1 + rest * 0.35
    : kind === 'spin-left' || kind === 'spin-right' ? 1 - rest * 0.3
    : kind === 'pop' ? 0.65 + pop * 0.35 : 1;
  const opacity = ['fade', 'zoom', 'zoom-out', 'whip', 'whip-left', 'whip-up', 'whip-down', 'spin-left', 'spin-right', 'pop', 'blur'].includes(kind) ? p : 1;
  const transform = x || y || rotation || scale !== 1 ? `translate(${x}%, ${y}%) rotate(${rotation}deg) scale(${scale})` : '';
  return { transform, x, y, rotation, scale, opacity,
    blur: kind.startsWith('whip') || kind === 'blur' ? rest * 12 : 0 };
}

/** Does not touch media time or volume; reused by regular and shared decoders. */
export function pictureAnimationAt(item: TimelineItem, frame: number) {
  const motion = resolvePictureAnimation(item.kind === 'audio' || item.kind === 'text' ? {} : item.props);
  const progress = pictureAnimationProgress(item, frame);
  const a = motionAt(motion.entrance, progress.entrance);
  const b = motionAt(motion.exit, progress.exit);
  return { transform: [a.transform, b.transform].filter(Boolean).join(' '), opacity: a.opacity * b.opacity, blur: a.blur + b.blur, surfaces: [a, b] };
}

/** A split preserves each visible animation sample rather than restarting it. */
export function splitPictureAnimationProps(item: TimelineItem, offset: number): TimelineItem['props'] {
  const timing = pictureAnimationTiming(item);
  if (!timing.entrance && !timing.exit) return item.props;
  const shift = (window: { from: number; until: number }) => ({ from: window.from - offset, until: window.until - offset });
  return { ...item.props,
    ...(timing.entrance ? { visualEntranceWindow: shift(timing.entrance) } : {}),
    ...(timing.exit ? { visualExitWindow: shift(timing.exit) } : {}),
  };
}

/** Split windows preserve original pixels until an explicit timing edit.
 * Thereafter the motions still present in this fragment attach to its new
 * edges. A finished entrance or an exit not reached by this fragment stays
 * absent, even if the fragment is subsequently extended or slowed down. */
export function rebasePictureAnimationAfterTiming(item: TimelineItem, next: TimelineItem): TimelineItem {
  if (item.kind === 'audio' || item.kind === 'text' || !item.props
    || (item.props.visualEntranceWindow === undefined && item.props.visualExitWindow === undefined)
    || (item.durationInFrames === next.durationInFrames
      && (item.srcInFrame ?? 0) === (next.srcInFrame ?? 0)
      && (item.playbackRate ?? 1) === (next.playbackRate ?? 1))) return next;
  const timing = pictureAnimationTiming(item);
  const entranceVisible = !!timing.entrance && timing.entrance.until > 0;
  const exitVisible = !!timing.exit && timing.exit.from < item.durationInFrames - 1;
  return { ...next, props: { ...next.props,
    ...(!entranceVisible && timing.entrance ? { visualEntrance: 'none' } : {}),
    ...(!exitVisible && timing.exit ? { visualExit: 'none' } : {}),
    visualEntranceWindow: undefined,
    visualExitWindow: undefined,
  } };
}
