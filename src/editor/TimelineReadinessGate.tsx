import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AbsoluteFill, cancelRender, continueRender, delayRender } from 'remotion';
import { prepareTimelineReadiness } from './timelineReadiness';
import type { TimelineState } from './types';

interface TimelineReadinessGateProps {
  state: TimelineState;
  dependencies?: readonly TimelineState[];
  children: () => ReactNode;
}

export function TimelineReadinessGate({ state, dependencies = [], children }: TimelineReadinessGateProps) {
  const [readinessStates] = useState(() => [state, ...dependencies]);
  const [handle] = useState(() => delayRender('Preparing project fonts and templates'));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let continued = false;
    const release = () => {
      if (continued) return;
      continued = true;
      continueRender(handle);
    };
    const fail = (reason: unknown) => {
      if (continued) return;
      continued = true;
      const readinessError = reason instanceof Error ? reason : new Error(String(reason));
      if (active) setError(readinessError.message);
      try {
        cancelRender(readinessError);
      } catch {
        // The Player keeps the explicit error UI above; headless rendering is already cancelled.
      }
    };
    Promise.resolve()
      .then(() => prepareTimelineReadiness(readinessStates))
      .then(
      () => { if (active) setReady(true); release(); },
      (reason: unknown) => fail(reason),
    );
    return () => { active = false; release(); };
  }, [handle, readinessStates]);

  if (error) return <AbsoluteFill style={{ color: '#f88', fontFamily: 'monospace', fontSize: 20, padding: 40, whiteSpace: 'pre-wrap' }}>{error}</AbsoluteFill>;
  return ready ? children() : null;
}
