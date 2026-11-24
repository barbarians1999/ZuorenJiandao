import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectDoc } from '../editor/types';
import { ensureMediaSrcs, isMediaSrcReachable } from '../persist/mediaBlobStore';

export function useOfflineMedia(doc: Pick<ProjectDoc, 'assets' | 'timelines'>) {
  const [offlineSrcs, setOfflineSrcs] = useState<Set<string>>(() => new Set());
  const offlineSrcsRef = useRef<ReadonlySet<string>>(offlineSrcs);
  offlineSrcsRef.current = offlineSrcs;
  const sourcesKey = useMemo(() => JSON.stringify([...new Set([
    ...doc.assets.filter((asset) => asset.kind !== 'motion-graphic' && asset.src).map((asset) => asset.src),
    ...doc.timelines.flatMap((timeline) => timeline.items.flatMap((item) => (
      [item.src, item.denoisedSrc].filter(Boolean) as string[]
    ))),
  ])].sort()), [doc.assets, doc.timelines]);

  useEffect(() => {
    let alive = true;
    const sources = JSON.parse(sourcesKey) as string[];
    void (async () => {
      const checked = await ensureMediaSrcs(sources).catch(() => null);
      const available = new Set([...(checked?.ok ?? []), ...(checked?.restored ?? [])]);
      const missing = new Set<string>();
      // Recovery has already probed readable uploads. Check the remaining
      // paths individually so project-wide probes cannot crowd out playback.
      for (const src of sources) {
        if (!alive) return;
        if (!available.has(src) && !await isMediaSrcReachable(src)) missing.add(src);
      }
      if (alive) setOfflineSrcs(missing);
    })();
    return () => { alive = false; };
  }, [sourcesKey]);

  const offlineAssetIds = useMemo(() => new Set(
    doc.assets.filter((asset) => offlineSrcs.has(asset.src)).map((asset) => asset.id),
  ), [doc.assets, offlineSrcs]);
  const markOffline = useCallback((src: string) => {
    setOfflineSrcs((current) => new Set(current).add(src));
  }, []);
  return { offlineSrcs, offlineSrcsRef, offlineAssetIds, markOffline };
}
