import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem } from '../../editor/types';
import { animationAuditionWindow, startAnimationAudition, type AnimationPreviewScope, type AnimationSide, type AuditionResult } from '../../editor/animationAudition';

export interface AnimationAuditionPreview {
  playerRef: RefObject<PlayerRef | null>;
  scope: AnimationPreviewScope;
  getScope: () => AnimationPreviewScope;
  onSeek: (frame: number) => void;
}

export function useAnimationAudition(item: TimelineItem, fps: number, preview?: AnimationAuditionPreview) {
  const [activeSide, setActiveSide] = useState<AnimationSide | null>(null);
  const [result, setResult] = useState<AuditionResult | null>(null);
  const trial = useRef<{ stop: () => void } | null>(null);
  const latest = useRef(preview); latest.current = preview;
  const mounted = useRef(true);
  // Content changes invalidate a trial, including a changed duration or motion.
  const revision = JSON.stringify([item, fps, preview?.scope]);
  useEffect(() => {
    mounted.current = true;
    setActiveSide(null);
    return () => {
      mounted.current = false;
      trial.current?.stop();
      trial.current = null;
    };
  }, [revision]);
  const stop = () => { trial.current?.stop(); trial.current = null; setActiveSide(null); };
  const start = (side: AnimationSide) => {
    stop();
    const input = latest.current;
    const player = input?.playerRef.current;
    const window = animationAuditionWindow(item, side, fps);
    if (!input || !player || !window) { setResult('unavailable'); return; }
    setActiveSide(side);
    setResult(null);
    const next = startAnimationAudition({ player, scope: input.scope, getScope: input.getScope,
      isCurrentPlayer: () => input.playerRef.current === player,
      seek: input.onSeek, window, fps, onFinish: (status) => {
        trial.current = null;
        if (mounted.current) { setActiveSide(null); setResult(status); }
      } });
    // A synchronous player error can finish before start returns.
    if (next.isActive()) trial.current = next;
  };
  return { activeSide, result, start, stop };
}
