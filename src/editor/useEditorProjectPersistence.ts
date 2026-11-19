import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { PlayerRef } from '@remotion/player';
import { useT } from '../i18n/locale';
import { acknowledgeSavedCaptionDrafts } from '../captions/captionDraftRecovery';
import {
  flushProjectSaves,
  hasPendingProjectSaves,
  hasProjectSaveFailure,
  saveProject,
} from '../persist/projectStore';
import { showAppToast } from '../ui/appToast';
import type { EditorCommands } from './store';
import type { ProjectDoc, TimelineState } from './types';
import { ProjectAutosaveQueue, type ProjectSaveStatus } from './projectAutosaveQueue';
export type { ProjectSaveStatus } from './projectAutosaveQueue';

type MutableRef<T> = { current: T };

interface EditorProjectPersistenceOptions {
  projectId: string;
  doc: ProjectDoc;
  commands: Pick<EditorCommands, 'addAsset'>;
  stateRef: MutableRef<TimelineState>;
  docRef: MutableRef<ProjectDoc>;
  playerRef: MutableRef<PlayerRef | null>;
  flushBeforeLeaveRef: MutableRef<() => Promise<boolean>>;
  onHome: () => void;
}

interface EditorSaveControls {
  saveStatus: ProjectSaveStatus;
  saveError?: string;
  retrySave: () => Promise<boolean>;
}

const projectSaveStore = { saveProject, flushProjectSaves, hasPendingProjectSaves, hasProjectSaveFailure };
export type ProjectSaveStore = typeof projectSaveStore;

export function useEditorAutosave(projectId: string, doc: ProjectDoc, store: ProjectSaveStore = projectSaveStore): EditorSaveControls & { flushBeforeLeave: () => Promise<boolean> } {
  const t = useT();
  const queue = useMemo(() => new ProjectAutosaveQueue(projectId, store.saveProject,
    (savedDoc) => acknowledgeSavedCaptionDrafts(projectId, savedDoc),
    (loadedDoc) => acknowledgeSavedCaptionDrafts(projectId, loadedDoc)), [projectId, store]);
  const feedback = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const saveFailureShownRef = useRef(false);
  const retryInFlightRef = useMemo(() => ({ current: null as Promise<boolean> | null }), [queue]);
  useEffect(() => {
    if (!queue.observe(doc)) return undefined;
    const timer = setTimeout(() => { void queue.enqueue(); }, 500);
    return () => clearTimeout(timer);
  }, [doc, queue]);
  useEffect(() => {
    if (feedback.status === 'error' && !saveFailureShownRef.current) {
      showAppToast(t('工程保存失败，请点击顶部“重试保存”。内容仍保留在当前窗口，保存成功前请勿关闭。'), { error: true });
      saveFailureShownRef.current = true;
    } else if (feedback.status === 'saved') saveFailureShownRef.current = false;
  }, [feedback.status, t]);
  const retrySave = useCallback((): Promise<boolean> => {
    if (retryInFlightRef.current) return retryInFlightRef.current;
    const saving = (async () => {
      const pending = queue.enqueue();
      if (pending) await pending;
      const result = await store.flushProjectSaves(projectId);
      // An edit made during the write is still awaiting its own autosave.
      return result.ok && !queue.hasPending();
    })();
    retryInFlightRef.current = saving;
    void saving.finally(() => { if (retryInFlightRef.current === saving) retryInFlightRef.current = null; });
    return saving;
  }, [queue, projectId, store, retryInFlightRef]);
  const flushBeforeLeave = useCallback(async (): Promise<boolean> => {
    if (!await retrySave()) {
      showAppToast(t('工程仍未保存，已阻止离开。请点击顶部“重试保存”。'), { error: true });
      return false;
    }
    return true;
  }, [retrySave, t]);
  useBrowserSaveGuards(projectId, queue, store);
  return { flushBeforeLeave, saveStatus: feedback.status, saveError: feedback.error, retrySave };
}

function useBrowserSaveGuards(projectId: string, queue: ProjectAutosaveQueue, store: ProjectSaveStore): void {
  useEffect(() => {
    const flushWithoutWaiting = (): void => {
      void queue.enqueue();
      void store.flushProjectSaves(projectId);
    };
    const blockUnfinishedSave = (event: BeforeUnloadEvent): void => {
      void queue.enqueue();
      if (queue.getSnapshot().status === 'saved' && !store.hasPendingProjectSaves(projectId) && !store.hasProjectSaveFailure(projectId)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', blockUnfinishedSave);
    window.addEventListener('pagehide', flushWithoutWaiting);
    return () => {
      window.removeEventListener('beforeunload', blockUnfinishedSave);
      window.removeEventListener('pagehide', flushWithoutWaiting);
      flushWithoutWaiting();
    };
  }, [queue, projectId, store]);
}

export function useEditorProjectPersistence({
  projectId,
  doc,
  flushBeforeLeaveRef,
  onHome,
}: EditorProjectPersistenceOptions): EditorSaveControls & { handleHome: () => Promise<void> } {
  const { flushBeforeLeave, ...saveControls } = useEditorAutosave(projectId, doc);
  flushBeforeLeaveRef.current = flushBeforeLeave;
  // usePlayheadPaint owns per-timeline resume. A second seek here used to
  // overwrite the restored position with zero after every subdraft switch.

  const handleHome = useCallback(async (): Promise<void> => {
    if (await flushBeforeLeave()) onHome();
  }, [flushBeforeLeave, onHome]);

  return { handleHome, ...saveControls };
}
