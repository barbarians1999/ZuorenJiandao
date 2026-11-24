import type { MediaAsset } from '../../editor/types';

export function isPreviewableSourceAsset(
  asset: Pick<MediaAsset, 'kind' | 'src'> | null | undefined,
): boolean {
  if (!asset) return false;
  if (asset.kind === 'motion-graphic') return true;
  if (
    asset.kind === 'video'
    || asset.kind === 'audio'
    || asset.kind === 'image'
    || asset.kind === 'gif'
    || asset.kind === 'svg'
  ) {
    return Boolean(asset.src);
  }
  return false;
}

export function formatSourcePreviewTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) {
    return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export interface SourceSwapSnapshot {
  prevAssetId: string | null;
  nextAssetId: string;
  currentTime: number;
  playing: boolean;
  muted: boolean;
}

export interface SourceSwapPlan {
  isSameAsset: boolean;
  resumeTime: number;
  shouldPlay: boolean;
  muted: boolean;
}

export function resolveSourceSwapPlan(snapshot: SourceSwapSnapshot): SourceSwapPlan {
  const isSameAsset = snapshot.prevAssetId === snapshot.nextAssetId;
  if (!isSameAsset) {
    return {
      isSameAsset: false,
      resumeTime: 0,
      shouldPlay: true,
      muted: false,
    };
  }
  return {
    isSameAsset: true,
    resumeTime: Number.isFinite(snapshot.currentTime) && snapshot.currentTime > 0 ? snapshot.currentTime : 0,
    shouldPlay: snapshot.playing,
    muted: snapshot.muted,
  };
}
