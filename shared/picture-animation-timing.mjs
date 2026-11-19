// Frame-only timing shared by the editor and the native/hybrid export planner.
export const PICTURE_ANIMATION_IDS = new Set(['none', 'fade', 'push-left', 'push-right', 'slide-up',
  'slide-down', 'zoom', 'zoom-out', 'whip', 'whip-left', 'whip-up', 'whip-down', 'spin-left', 'spin-right', 'pop', 'blur']);
const clamp = (n) => Math.max(0, Math.min(1, n));
const frames = (value) => Number.isFinite(Number(value)) ? Math.round(Math.max(1, Math.min(300, Number(value)))) : 12;
const validWindow = (value) => value && Number.isFinite(value.from) && Number.isFinite(value.until)
  && value.until > value.from && Math.abs(value.from) < Number.MAX_SAFE_INTEGER && Math.abs(value.until) < Number.MAX_SAFE_INTEGER;

export function pictureAnimationTiming(item) {
  const props = item.kind === 'audio' || item.kind === 'text' ? {} : item.props ?? {};
  const kind = (side) => PICTURE_ANIMATION_IDS.has(props[`visual${side}`]) ? props[`visual${side}`] : 'none';
  const entrance = kind('Entrance'), exit = kind('Exit');
  const span = Math.max(0, item.durationInFrames - 1);
  const a = entrance === 'none' ? 0 : frames(props.visualEntranceFrames);
  const b = exit === 'none' ? 0 : frames(props.visualExitFrames);
  const anchoredA = validWindow(props.visualEntranceWindow), anchoredB = validWindow(props.visualExitWindow);
  const factor = a + b > span ? span / (a + b) : 1;
  return {
    entrance: entrance === 'none' ? null : anchoredA ? props.visualEntranceWindow : span < 2 ? null
      : { from: 0, until: anchoredB ? Math.min(a, span) : a * factor },
    exit: exit === 'none' ? null : anchoredB ? props.visualExitWindow : span < 2 ? null
      : { from: span - (anchoredA ? Math.min(b, span) : b * factor), until: span },
  };
}

export function pictureAnimationProgress(item, frame) {
  const timing = pictureAnimationTiming(item);
  return {
    entrance: timing.entrance ? clamp((frame - timing.entrance.from) / (timing.entrance.until - timing.entrance.from)) : 1,
    exit: timing.exit ? clamp((timing.exit.until - frame) / (timing.exit.until - timing.exit.from)) : 1,
  };
}

/** Half-open global frame ranges containing non-neutral animation pixels. */
export function pictureAnimationWindows(item) {
  const timing = pictureAnimationTiming(item), start = item.startFrame, end = start + item.durationInFrames;
  const ranges = [];
  if (timing.entrance) ranges.push([start, Math.min(end, start + Math.ceil(timing.entrance.until))]);
  if (timing.exit) ranges.push([Math.max(start, start + Math.floor(timing.exit.from) + 1), end]);
  return ranges.filter(([from, until]) => until > from);
}

const keys = new Set(['visualEntrance', 'visualExit', 'visualEntranceFrames', 'visualExitFrames', 'visualEntranceWindow', 'visualExitWindow']);
export function pictureOnlyProps(props) {
  if (props == null) return true;
  if (typeof props !== 'object' || Array.isArray(props)) return false;
  return Object.entries(props).every(([key, value]) => value === undefined || keys.has(key)
    && (key.endsWith('Window') ? validWindow(value) : key.endsWith('Frames') ? Number.isFinite(Number(value))
      : PICTURE_ANIMATION_IDS.has(value)));
}
export function neutralPictureProps(item) {
  return pictureOnlyProps(item.props) && pictureAnimationWindows(item).length === 0;
}
