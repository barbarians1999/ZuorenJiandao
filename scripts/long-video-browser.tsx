// Test-only host using the production composition, preview resolver and export engine.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition } from '../src/editor/TimelineComposition';
import { docFromTimeline } from '../src/persist/projectStore';
import { usePreviewProjectDoc, retryPreviewProxy, requestPreviewProxy } from '../src/media/previewMedia';
import { getPreviewSourceMode } from '../src/media/qualityPolicy';
import { PreviewSourceToggle, PreviewProxyStatus } from '../src/components/preview/PreviewSourceControls';
import type { TimelineState } from '../src/editor/types';
import { presentationProbe } from './long-video-presentation';

const initial: TimelineState = { fps: 30, width: 1920, height: 1080, fit: 'contain', selectedId: null, items: [] };

function Host() {
  const [state, setState] = useState(initial);
  const player = useRef<PlayerRef>(null);
  const project = docFromTimeline(state);
  // Stable state/document identity avoids aborting proxy generation on every render.
  const [viewProject, setViewProject] = useState(project);
  const preview = usePreviewProjectDoc(viewProject, viewProject.timelines[0].id);
  useEffect(() => {
    window.longVideoBench = {
      load: (next, mode) => {
        player.current?.pause();
        // Exercise the actual UI click handlers, not a private quality setter.
        const button = document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[mode === 'original' ? 0 : 1];
        if (!button) throw new Error('Preview source control missing');
        button.click(); setState(next); setViewProject(docFromTimeline(next));
      },
      status: () => ({ items: state.items.length, mode: getPreviewSourceMode(), proxies: preview.proxies,
        memory: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
        originalUnchanged: JSON.stringify(viewProject).includes('preview-proxy-file') === false }),
      retrySource: async (src) => {
        // First finish a concurrent readiness lookup. Then await the explicit
        // rebuild, so an old cached ready response cannot end its timing early.
        await requestPreviewProxy(src, true);
        await retryPreviewProxy(src);
      },
      ...presentationProbe(() => state, player),
    };
  }, [state, preview, viewProject]);
  return <><PreviewSourceToggle /><PreviewProxyStatus proxies={preview.proxies} />
    <Player ref={player} component={TimelineComposition} inputProps={{ state: preview.state, project: preview.project,
      timelineId: preview.state.id }} durationInFrames={21600} compositionWidth={1920} compositionHeight={1080}
      fps={30} numberOfSharedAudioTags={32} style={{ width: 960, height: 540 }} controls={false} />
  </>;
}
createRoot(document.getElementById('root')!).render(<Host />);
