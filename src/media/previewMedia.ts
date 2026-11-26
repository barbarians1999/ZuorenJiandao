import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  getPreviewSourceMode,
  getQualityMode,
  shouldAutoRequestPreviewProxy,
  shouldPreferMasterPreview,
  subscribeQualityMode,
} from './qualityPolicy';
import type { ProjectDoc, TimelineState } from '../editor/types';
import { resolveTimelineRenderPlan } from '../editor/sequenceGraph';
import { isPreviewable } from './clipPreview';

export interface PreviewProxySource {
  src: string;
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  longGop: boolean;
  hasAlpha?: boolean;
  hasAudio?: boolean;
}

export type PreviewProxyReadiness =
  | { status: 'not-needed'; reason: string }
  | { status: 'ready'; reason: string; previewSrc: string }
  | { status: 'failed'; reason: string; error: string };

export interface PreviewProxyResponse {
  source: PreviewProxySource;
  proxy: PreviewProxyReadiness;
}

export type PreviewProxyState = PreviewProxyReadiness
  | { status: 'loading'; reason: string }
  | { status: 'unavailable'; reason: string };

interface ProxyEntry {
  response: PreviewProxyResponse | null;
  promise: Promise<void> | null;
  controller: AbortController | null;
  listeners: Set<() => void>;
  force: boolean;
}

const proxyEntries = new Map<string, ProxyEntry>();

function proxyEntry(src: string): ProxyEntry {
  let entry = proxyEntries.get(src);
  if (!entry) {
    entry = { response: null, promise: null, controller: null, listeners: new Set(), force: false };
    proxyEntries.set(src, entry);
  }
  return entry;
}

function notify(entry: ProxyEntry): void {
  for (const listener of entry.listeners) listener();
}

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `preview proxy request failed (${response.status})`;
}

function failedResponse(src: string, error: unknown): PreviewProxyResponse {
  return {
    source: { src, durationMs: 0, width: 0, height: 0, codec: '', longGop: false },
    proxy: {
      status: 'failed',
      reason: 'proxy-request-failed',
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function isUpgradeableNotNeeded(proxy: PreviewProxyReadiness | undefined): boolean {
  return proxy?.status === 'not-needed' && proxy.reason !== 'alpha-channel-preserved';
}

const silentPreviewUrls = new Set<string>();
const alphaPreviewUrls = new Set<string>();
let metaVersion = 0;
const metaListeners = new Set<() => void>();

function emitPreviewMeta(): void {
  metaVersion += 1;
  for (const listener of metaListeners) listener();
}

export function subscribePreviewSourceMeta(listener: () => void): () => void {
  metaListeners.add(listener);
  return () => { metaListeners.delete(listener); };
}

export function getPreviewSourceMetaVersion(): number {
  return metaVersion;
}

function recordAudioPresence(src: string, response: PreviewProxyResponse | null): void {
  const hasAudio = response?.source.hasAudio;
  const previewSrc = response?.proxy.status === 'ready' ? response.proxy.previewSrc : undefined;
  let changed = false;
  if (hasAudio === false) {
    if (!silentPreviewUrls.has(src)) { silentPreviewUrls.add(src); changed = true; }
    if (previewSrc && !silentPreviewUrls.has(previewSrc)) { silentPreviewUrls.add(previewSrc); changed = true; }
  } else if (hasAudio === true) {
    if (silentPreviewUrls.delete(src)) changed = true;
    if (previewSrc && silentPreviewUrls.delete(previewSrc)) changed = true;
  }
  if (changed) emitPreviewMeta();
}

function recordAlphaPresence(src: string, response: PreviewProxyResponse | null): void {
  const hasAlpha = response?.source.hasAlpha;
  const previewSrc = response?.proxy.status === 'ready' ? response.proxy.previewSrc : undefined;
  let changed = false;
  if (hasAlpha === true) {
    if (!alphaPreviewUrls.has(src)) { alphaPreviewUrls.add(src); changed = true; }
    if (previewSrc && !alphaPreviewUrls.has(previewSrc)) { alphaPreviewUrls.add(previewSrc); changed = true; }
  } else if (hasAlpha === false) {
    if (alphaPreviewUrls.delete(src)) changed = true;
    if (previewSrc && alphaPreviewUrls.delete(previewSrc)) changed = true;
  }
  if (changed) emitPreviewMeta();
}

export function isPreviewSourceSilent(src: string | undefined): boolean {
  return Boolean(src && silentPreviewUrls.has(src));
}

export function isPreviewSourceAlpha(src: string | undefined): boolean {
  if (!src) return false;
  if (alphaPreviewUrls.has(src)) return true;
  const withoutHash = src.split('#')[0] ?? src;
  const [base = '', query = ''] = withoutHash.split('?');
  if (/(?:^|&)format=webm(?:&|$)/i.test(query)) return true;
  return base.toLowerCase().endsWith('.webm');
}

export function isBrowserPlayableNativeVideo(src: string | undefined): boolean {
  if (!src) return false;
  const withoutHash = src.split('#')[0] ?? src;
  const [base = ''] = withoutHash.split('?');
  const lower = base.toLowerCase();
  if (lower.startsWith('blob:') || lower.startsWith('data:video/mp4') || lower.startsWith('data:video/webm')) return true;
  if (lower === '/api/preview-proxy-file') return true;
  return lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.webm') || lower.endsWith('.ogv');
}

export function isBrowserPlayableNativeAlpha(src: string | undefined): boolean {
  if (!src || !isPreviewSourceAlpha(src)) return false;
  const withoutHash = src.split('#')[0] ?? src;
  const [base = '', query = ''] = withoutHash.split('?');
  if (/(?:^|&)format=webm(?:&|$)/i.test(query)) return true;
  if (/\.(?:mov|avi|mxf|mkv)$/i.test(base)) return false;
  return true;
}

export function usePreviewSourceSilent(src: string | undefined): boolean {
  useSyncExternalStore(subscribePreviewSourceMeta, getPreviewSourceMetaVersion, getPreviewSourceMetaVersion);
  return isPreviewSourceSilent(src);
}

export function usePreviewSourceAlpha(src: string | undefined): boolean {
  useSyncExternalStore(subscribePreviewSourceMeta, getPreviewSourceMetaVersion, getPreviewSourceMetaVersion);
  return isPreviewSourceAlpha(src);
}

async function loadProxy(src: string, force: boolean, entry: ProxyEntry, retry = false): Promise<void> {
  if (entry.promise) {
    await entry.promise;
    if (force && !entry.force && isUpgradeableNotNeeded(entry.response?.proxy)) await loadProxy(src, true, entry);
    return;
  }
  if (!retry && entry.response && (!force || !isUpgradeableNotNeeded(entry.response.proxy))) return;
  entry.force = force;
  entry.response = null;
  notify(entry);
  const query = `src=${encodeURIComponent(src)}${force ? '&force=1' : ''}${retry ? '&retry=1' : ''}`;
  const controller = new AbortController();
  entry.controller = controller;
  entry.promise = fetch(`/api/preview-proxy?${query}`, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      entry.response = await response.json() as PreviewProxyResponse;
      recordAudioPresence(src, entry.response);
      recordAlphaPresence(src, entry.response);
    })
    .catch((error) => {
      if (!controller.signal.aborted) entry.response = failedResponse(src, error);
    })
    .finally(() => {
      if (entry.controller === controller) entry.controller = null;
      entry.promise = null;
      notify(entry);
    });
  await entry.promise;
}

export function requestPreviewProxy(src: string, force = false, retry = false): Promise<void> {
  if (!isPreviewable(src)) return Promise.resolve();
  return loadProxy(src, force, proxyEntry(src), retry);
}

/** Explicit user action only: failed results remain cached until this is called. */
export function retryPreviewProxy(src: string): Promise<void> {
  return requestPreviewProxy(src, true, true);
}

export function reportPreviewPlaybackFailure(src: string, error = 'preview media failed to play'): void {
  if (!isPreviewable(src)) return;
  const entry = proxyEntry(src);
  if (entry.response?.proxy.status !== 'ready') {
    if (entry.response?.proxy.status !== 'failed') void requestPreviewProxy(src, true);
    return;
  }
  entry.response = {
    ...entry.response,
    proxy: { status: 'failed', reason: 'proxy-playback-failed', error },
  };
  notify(entry);
}

export function mediaPosterUrl(src: string | undefined): string | undefined {
  return isPreviewable(src) ? `/api/media-poster?src=${encodeURIComponent(src)}` : undefined;
}

export function previewProxyState(src: string | undefined, autoRequest = shouldAutoRequestPreviewProxy()): PreviewProxyState {
  if (!isPreviewable(src)) return { status: 'unavailable', reason: 'non-local-source' };
  const entry = proxyEntry(src);
  if (!entry.response) {
    return autoRequest
      ? { status: 'loading', reason: 'checking-source' }
      : { status: 'not-needed', reason: 'preview-source-original' };
  }
  return entry.response.proxy;
}

const stateFor = previewProxyState;

function subscribe(sources: readonly string[], listener: () => void): () => void {
  for (const src of sources) proxyEntry(src).listeners.add(listener);
  return () => {
    for (const src of sources) {
      const entry = proxyEntries.get(src);
      if (!entry) continue;
      entry.listeners.delete(listener);
      if (!entry.listeners.size && entry.promise) {
        entry.controller?.abort();
        if (proxyEntries.get(src) === entry) proxyEntries.delete(src);
      }
    }
  };
}

function useQualitySnapshot() {
  // Separate stable snapshots: getSnapshot must return a cached value, or
  // useSyncExternalStore re-renders forever on every new object literal.
  const mode = useSyncExternalStore(subscribeQualityMode, getQualityMode, getQualityMode);
  const preview = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  return { mode, preview };
}

const EMPTY_SOURCES: string[] = [];

function useStableSources(sources: readonly string[]): string[] {
  const key = sources.join('\u0000');
  return useMemo(() => (key ? key.split('\u0000') : EMPTY_SOURCES), [key]);
}

function useProxySources(sources: readonly string[], playing = false): number {
  const [revision, setRevision] = useState(0);
  const quality = useQualitySnapshot();
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    return subscribe(sources, bump);
  }, [sources]);
  useEffect(() => {
    // Only fetch proxies when idle/paused and policy/source mode expects them.
    if (!playing && shouldAutoRequestPreviewProxy(quality.mode, quality.preview)) {
      for (const src of sources) void requestPreviewProxy(src, quality.preview === 'proxy');
    }
  }, [sources, playing, quality.mode, quality.preview]);
  // Re-resolve preview src when quality/preview-source mode flips even if proxy cache is quiet.
  useEffect(() => {
    setRevision((value) => value + 1);
  }, [quality.mode, quality.preview]);
  return revision;
}

function sameUrlMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function hasReadyForcedProxy(src: string): boolean {
  const entry = proxyEntries.get(src);
  return Boolean(entry?.force && entry.response?.proxy.status === 'ready');
}

export function resolvePreviewSrc(src: string | undefined, proxy: PreviewProxyState): string | undefined {
  if (shouldPreferMasterPreview() && src) return src;
  return proxy.status === 'ready' ? proxy.previewSrc : src;
}

/** Derive a view document, never write proxy URLs back into persisted editing state. */
export function projectForPreview(project: ProjectDoc, sources: ReadonlyMap<string, string>): ProjectDoc {
  return { ...project, timelines: project.timelines.map((timeline) => ({ ...timeline,
    items: timeline.items.map((item) => {
      const src = item.kind === 'video' && item.src ? sources.get(item.src) : undefined;
      return src && src !== item.src ? { ...item, src } : item;
    }),
  })) };
}

export function usePreviewMediaSource(src: string | undefined, enabled = true) {
  const rawSource = isPreviewable(src) ? src : '';
  const source = enabled ? rawSource : '';
  const sources = useMemo(() => source ? [source] : [], [source]);
  const revision = useProxySources(sources);
  const proxy = stateFor(source || undefined, shouldAutoRequestPreviewProxy());
  const previewSrc = resolvePreviewSrc(src, proxy);
  return {
    sourceSrc: src,
    previewSrc,
    posterSrc: mediaPosterUrl(rawSource || undefined),
    proxy,
    requestFallback: useCallback(() => {
      if (source) reportPreviewPlaybackFailure(source);
    }, [source]),
    revision,
  };
}

export function memoizePreviewTimelineState(
  previous: { input: TimelineState; urls: Map<string, string>; output: TimelineState } | null,
  state: TimelineState,
  urls: Map<string, string>,
): { input: TimelineState; urls: Map<string, string>; output: TimelineState } {
  if (previous && previous.input === state && sameUrlMap(previous.urls, urls)) {
    return previous;
  }
  const output: TimelineState = {
    ...state,
    items: state.items.map((item) => {
      if (item.kind !== 'video' || !item.src) return item;
      const previewSrc = urls.get(item.src);
      return previewSrc && previewSrc !== item.src ? { ...item, src: previewSrc } : item;
    }),
  };
  return { input: state, urls, output };
}

export function memoizePreviewProjectDoc(
  previous: { input: ProjectDoc; urls: Map<string, string>; output: ProjectDoc } | null,
  project: ProjectDoc,
  urls: Map<string, string>,
): { input: ProjectDoc; urls: Map<string, string>; output: ProjectDoc } {
  if (previous && previous.input === project && sameUrlMap(previous.urls, urls)) {
    return previous;
  }
  return { input: project, urls, output: projectForPreview(project, urls) };
}

export function usePreviewTimelineState(state: TimelineState, options?: { playing?: boolean }) {
  const playing = options?.playing ?? false;
  const rawSources = useMemo(() => [...new Set(state.items
    .filter((item) => item.kind === 'video' && isPreviewable(item.src))
    .map((item) => item.src!))].sort(), [state.items]);
  const sources = useStableSources(rawSources);
  const revision = useProxySources(sources, playing);
  const resolvedCacheRef = useRef<Map<string, string>>(new Map());
  const memoRef = useRef<{ input: TimelineState; urls: Map<string, string>; output: TimelineState } | null>(null);
  const previewState = useMemo<TimelineState>(() => {
    void revision; // recompute when the proxy cache bumps (proxies live in module state)
    const nextCache = new Map<string, string>();
    const autoRequest = shouldAutoRequestPreviewProxy();
    for (const src of sources) {
      if (playing && resolvedCacheRef.current.has(src) && !hasReadyForcedProxy(src)) {
        nextCache.set(src, resolvedCacheRef.current.get(src)!);
      } else {
        const proxy = stateFor(src, autoRequest);
        nextCache.set(src, resolvePreviewSrc(src, proxy) ?? src);
      }
    }
    resolvedCacheRef.current = nextCache;
    memoRef.current = memoizePreviewTimelineState(memoRef.current, state, nextCache);
    return memoRef.current.output;
  }, [state, sources, revision, playing]);
  const proxies = sources.map((src) => ({ src, proxy: stateFor(src, shouldAutoRequestPreviewProxy()) }));
  return {
    state: previewState,
    proxies,
    requestFallback: (src: string) => { reportPreviewPlaybackFailure(src); },
  };
}

/** Resolve preview proxies across the complete reachable nested-sequence graph. */
export function usePreviewProjectDoc(project: ProjectDoc, timelineId: string, options?: { playing?: boolean }) {
  const playing = options?.playing ?? false;
  const plan = useMemo(() => resolveTimelineRenderPlan(project, timelineId), [project, timelineId]);
  const reachable = useMemo(() => new Set(plan.timelineIds), [plan.timelineIds]);
  const rawSources = useMemo(() => [...new Set(project.timelines
    .filter((timeline) => reachable.has(timeline.id))
    .flatMap((timeline) => timeline.items)
    .filter((item) => item.kind === 'video' && isPreviewable(item.src))
    .map((item) => item.src!))].sort(), [project.timelines, reachable]);
  const sources = useStableSources(rawSources);
  const revision = useProxySources(sources, playing);
  const resolvedCacheRef = useRef<Map<string, string>>(new Map());
  const memoRef = useRef<{ input: ProjectDoc; urls: Map<string, string>; output: ProjectDoc } | null>(null);
  const previewProject = useMemo<ProjectDoc>(() => {
    void revision; // recompute when the proxy cache bumps (proxies live in module state)
    const nextCache = new Map<string, string>();
    const autoRequest = shouldAutoRequestPreviewProxy();
    for (const src of sources) {
      if (playing && resolvedCacheRef.current.has(src) && !hasReadyForcedProxy(src)) {
        nextCache.set(src, resolvedCacheRef.current.get(src)!);
      } else {
        nextCache.set(src, resolvePreviewSrc(src, stateFor(src, autoRequest)) ?? src);
      }
    }
    resolvedCacheRef.current = nextCache;
    memoRef.current = memoizePreviewProjectDoc(memoRef.current, project, nextCache);
    return memoRef.current.output;
  }, [project, revision, sources, playing]);
  const state = previewProject.timelines.find((timeline) => timeline.id === timelineId)!;
  return {
    project: previewProject,
    state,
    plan,
    proxies: sources.map((src) => ({ src, proxy: stateFor(src, shouldAutoRequestPreviewProxy()) })),
    requestFallback: (src: string) => { reportPreviewPlaybackFailure(src); },
  };
}
