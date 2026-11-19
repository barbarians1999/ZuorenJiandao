import type { MediaAssetKind } from '../editor/types';

export type MediaPlacementPurpose = 'bgm';

/** A conservative default that keeps narration clearly above newly added music. */
export const BACKGROUND_MUSIC_INITIAL_VOLUME = 0.25;

export function mediaPlacementVolume(
  kind: MediaAssetKind,
  purpose?: MediaPlacementPurpose,
): number | undefined {
  return kind === 'audio' && purpose === 'bgm'
    ? BACKGROUND_MUSIC_INITIAL_VOLUME
    : undefined;
}
