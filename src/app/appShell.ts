import { startUiLocaleSync } from '../i18n/localeSync';
import { useCallback, useEffect, useState } from 'react';
import { setAutoTranscribeIngest, TRANSCRIPTION_LANGUAGE_KEY, TRANSCRIPTION_DIARIZATION_KEY } from '../transcript/provider';
import type { ProjectDoc, TimelineState } from '../editor/types';
import {
  createProject,
  docFromTimeline,
  hasProjectHistory,
  listProjects,
} from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { kvRemoteMode } from '../persist/sharedKv';
import { projectStoreWriteCredential } from '../persist/projectStoreTransport';
import { editorRouteFromHash, type ProjectQuickStart } from './projectQuickStart';

export type AppRoute = { name: 'dashboard' } | { name: 'editor'; id: string; quickStart?: ProjectQuickStart };

interface LiveAgentStatus {
  readonly caps?: Record<string, boolean>;
  readonly keys?: Record<string, { readonly configured: boolean }>;
  readonly models?: Record<string, string>;
}

const emptyState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
  interaction: { mainTrackId: 'track_v1', magnet: false, linkage: false, snapping: true },
});

export const emptyProjectDoc = (): ProjectDoc => docFromTimeline(emptyState());
// Keep the sample timeline out of established users' startup bundle; it is needed only on first run.
const seedDoc = async (): Promise<ProjectDoc> => docFromTimeline((await import('../editor/initial')).INITIAL);

function parseHash(): AppRoute {
  const editor = editorRouteFromHash(window.location.hash);
  return editor ? { name: 'editor', ...editor } : { name: 'dashboard' };
}

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}

export async function syncAgentBackends(isActive: () => boolean): Promise<void> {
  try {
    const response = await fetch('/api/keys');
    if (!response.ok || !isActive()) return;
    const { models } = await response.json() as LiveAgentStatus;
    if (!isActive()) return;
    startUiLocaleSync(models?.UI_LOCALE);
    if (!models) return;
    if (models.LOCAL_ASR_MODEL) localStorage.setItem('cc.asrModel', models.LOCAL_ASR_MODEL);
    setAutoTranscribeIngest(models.AUTO_TRANSCRIBE_INGEST === 'off' ? 'off' : 'local');
    if (models.TRANSCRIPTION_LANGUAGE) localStorage.setItem(TRANSCRIPTION_LANGUAGE_KEY, models.TRANSCRIPTION_LANGUAGE);
    if (models.TRANSCRIPTION_DIARIZATION) localStorage.setItem(TRANSCRIPTION_DIARIZATION_KEY, models.TRANSCRIPTION_DIARIZATION);
  } catch {
    // Local settings failure never blocks project startup.
  }
}

export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(parseHash());
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function useAgentBackendSync(): void {
  useEffect(() => {
    let alive = true;
    void syncAgentBackends(() => alive);
    return () => { alive = false; };
  }, []);
}

export interface ProjectStartupSource {
  list(): Promise<ProjectMeta[]>;
  hasHistory(): Promise<boolean>;
  canSeedDemo(): boolean;
  createDemo(): Promise<ProjectMeta>;
}

const projectStartupSource: ProjectStartupSource = {
  list: listProjects,
  hasHistory: hasProjectHistory,
  canSeedDemo: () => kvRemoteMode() === 'local' || projectStoreWriteCredential(),
  createDemo: async () => createProject('示例工程', await seedDoc()),
};

export async function loadInitialProjects(
  source: ProjectStartupSource = projectStartupSource,
): Promise<ProjectMeta[]> {
  const list = await source.list();
  if (list.length > 0 || await source.hasHistory()) return list;
  if (!source.canSeedDemo()) return [];
  return [await source.createDemo()];
}

function sameProjectMetaList(a: readonly ProjectMeta[], b: readonly ProjectMeta[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index]!;
    return item.id === other.id
      && item.name === other.name
      && item.updatedAt === other.updatedAt
      && item.deletedAt === other.deletedAt;
  });
}

export function useProjects(): {
  projects: ProjectMeta[] | null;
  refresh: () => Promise<void>;
} {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const refresh = useCallback(async () => {
    const next = await listProjects();
    setProjects((prev) => (prev && sameProjectMetaList(prev, next) ? prev : next));
  }, []);
  useEffect(() => {
    void loadInitialProjects().then(setProjects);
  }, []);
  return { projects, refresh };
}
