import type { AudioAsset } from './library';
import type { EditorCommands } from '../editor/storeCommands';
import { timelineTrackIds, trackKind, type TimelineState, type TrackId } from '../editor/types';
import { SOUND_EFFECTS, soundEffectSrc } from './soundLibrary';
import { rememberSoundUse } from './soundCollections';
import { t } from '../i18n/locale';

export interface SoundPlacementOptions { startFrame: number; track?: TrackId; newTrack?: boolean; }
export type SoundPlacementPlan =
  | { ok: true; startFrame: number; track?: TrackId; newTrack: boolean }
  | { ok: false; error: string };

/** Keep the requested editorial moment: use another lane instead of moving or replacing audio. */
export function planSoundPlacement(state: TimelineState, duration: number, options: SoundPlacementOptions): SoundPlacementPlan {
  if (!Number.isFinite(options.startFrame) || !Number.isFinite(duration) || duration < 1) {
    return { ok: false, error: t('音效位置或时长无效，未添加。') };
  }
  const startFrame = Math.max(0, Math.round(options.startFrame));
  const endFrame = startFrame + Math.round(duration);
  const available = (id: TrackId) => {
    const flags = state.tracks?.[id];
    return trackKind(state, id) === 'audio' && !flags?.locked && !flags?.muted && !flags?.hidden && !flags?.role
      && !state.items.some((item) => item.track === id && item.startFrame < endFrame && item.startFrame + item.durationInFrames > startFrame);
  };
  if (options.track && state.tracks?.[options.track]?.locked) {
    return { ok: false, error: t('这条轨道已锁定，请解锁或拖到新增轨道区域。') };
  }
  if (options.newTrack) return { ok: true, startFrame, newTrack: true };
  if (options.track && available(options.track)) return { ok: true, startFrame, track: options.track, newTrack: false };
  // An explicitly occupied/audio-routing lane gets a fresh ordinary lane; do not
  // silently place elsewhere or inherit speech/music ducking from the target.
  if (options.track && trackKind(state, options.track) === 'audio') return { ok: true, startFrame, newTrack: true };
  const track = timelineTrackIds(state).find(available);
  return { ok: true, startFrame, track, newTrack: !track };
}

export function soundAssetForId(id: string, fps: number): AudioAsset | null {
  const sound = SOUND_EFFECTS.find((entry) => entry.id === id);
  if (!sound || !Number.isFinite(fps) || fps <= 0) return null;
  return { id: `sfx_${id}`, name: sound.name, category: 'sfx', src: soundEffectSrc(id),
    durationInFrames: Math.max(1, Math.round(sound.seconds * fps)) };
}

export function placeSound(state: TimelineState, commands: EditorCommands, asset: AudioAsset,
  options: SoundPlacementOptions, notice: (message: string) => void): boolean {
  const plan = planSoundPlacement(state, asset.durationInFrames, options);
  if (!plan.ok) { notice(plan.error); return false; }
  commands.beginHistoryGesture();
  try {
    const track = plan.newTrack ? commands.createTrack('audio', { name: t('音效') }) : plan.track!;
    const result = commands.addAudio(asset, { track, startFrame: plan.startFrame });
    commands.selectItem(result.itemId);
    rememberSoundUse(asset.id.replace(/^sfx_/, ''));
    return true;
  } finally { commands.endHistoryGesture(); }
}
