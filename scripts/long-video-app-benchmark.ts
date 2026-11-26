// Imported only by the explicitly opted-in DEV editor. No hooks ship in packages.
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorCommands } from '../src/editor/storeCommands';
import type { ProjectDoc, TimelineState } from '../src/editor/types';
import { docFromTimeline, flushProjectSaves } from '../src/persist/projectStore';
import { waitForBrowserProjectOwnership } from '../src/persist/projectStoreTransport';
import { requestEntry } from '../src/persist/sharedKvRequests';
import { getPreviewSourceMode } from '../src/media/qualityPolicy';
import { previewProxyState, requestPreviewProxy, retryPreviewProxy } from '../src/media/previewMedia';
import { presentationProbe } from './long-video-presentation';

export function attachEditorBenchmark({ stateRef, docRef, commands, playerRef, projectId, flushBeforeLeaveRef }: {
  stateRef: RefObject<TimelineState>;
  docRef: RefObject<ProjectDoc>;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  projectId: string;
  flushBeforeLeaveRef: RefObject<() => Promise<boolean>>;
}) {
  const api = {
    flush: async () => {
      if (!await flushBeforeLeaveRef.current()) throw new Error('Editor save failed before benchmark navigation');
      const stored = await requestEntry(`project:${projectId}`);
      if (!stored.found) throw new Error('Committed benchmark project missing');
      return { originalUnchanged: !JSON.stringify(stored.value).includes('preview-proxy-file'),
        scope: 'real editor leave/save barrier and authoritative store entry, not live docRef only' };
    },
    select: (id: string | null) => commands.selectItem(id),
    pointerAt: async (frame: number) => {
      const ruler = document.querySelector<HTMLElement>('.cc-timeline-ruler');
      const head = ruler?.querySelector<HTMLElement>('.cc-ruler-head');
      const slider = document.querySelector<HTMLInputElement>('.cc-timeline input[type="range"]');
      const inner = ruler?.parentElement, scroll = inner?.parentElement;
      if (!ruler || !head || !slider || !inner || !scroll) throw new Error('Full timeline geometry missing');
      // Range inputs round their exposed value to `step`; use the ruler's
      // actual geometry, not that rounded slider value, for frame requests.
      const px = Number(ruler.dataset.timelinePixelsPerFrame);
      if (!(px > 0)) throw new Error('Invalid timeline frame geometry');
      const headerWidth = head.getBoundingClientRect().width;
      const contentX = frame * px + headerWidth;
      if (contentX < scroll.scrollLeft + headerWidth + 8 || contentX > scroll.scrollLeft + scroll.clientWidth - 8) {
        scroll.scrollLeft = Math.max(0, contentX - scroll.clientWidth / 2);
      }
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      const x = inner.getBoundingClientRect().left + headerWidth + frame * px;
      const box = ruler.getBoundingClientRect();
      return { x, y: box.top + box.height / 2 };
    },
    load: async (next: TimelineState, mode: 'original' | 'proxy') => {
      playerRef.current?.pause();
      // Measure an initialized editor, not a bulk replacement racing its
      // startup registration. Never bypass revision/ownership checks.
      if (!await waitForBrowserProjectOwnership(projectId)) throw new Error('Editor ownership initialization timeout');
      const previousSave = await flushProjectSaves(projectId);
      if (!previousSave.ok) throw new Error('Previous editor document did not commit');
      // Empty editors have no source controls or Player yet. Populate through
      // the real editor command first, then operate the rendered controls.
      commands.applyDoc(docFromTimeline(next));
      const label = mode === 'original' ? '\u539f\u7247' : '\u6d41\u7545';
      const deadline = performance.now() + 15000;
      let button: HTMLButtonElement | undefined;
      let select: HTMLSelectElement | null = null;
      do {
        select = document.querySelector<HTMLSelectElement>('select.cc-preview-quality-select');
        if (select) break;
        button = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
          .find((entry) => entry.textContent?.trim() === label);
        if (button) break;
        await new Promise((done) => setTimeout(done, 50));
      } while (performance.now() < deadline);
      if (select) {
        select.value = mode;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (!button) throw new Error(`Editor preview source control missing: ${document.body.innerText.slice(0, 1200)}`);
      button.click();
    },
    status: () => ({ items: stateRef.current.items.length, mode: getPreviewSourceMode(),
      proxies: [...new Set(stateRef.current.items.filter((item) => item.kind === 'video' && item.src)
        .map((item) => item.src!))].map((src) => ({ src, proxy: previewProxyState(src) })),
      originalUnchanged: !JSON.stringify(docRef.current).includes('preview-proxy-file'),
      editorUi: !!document.querySelector('.cc-timeline'), playerReady: !!playerRef.current,
      playerFrame: playerRef.current?.getCurrentFrame() ?? null,
      memory: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null }),
    retrySource: async (src: string) => {
      await requestPreviewProxy(src, true);
      await retryPreviewProxy(src);
    },
    ...presentationProbe(() => stateRef.current, playerRef),
  };
  window.longVideoBench = api;
  return () => { if (window.longVideoBench === api) delete (window as Partial<Window>).longVideoBench; };
}
