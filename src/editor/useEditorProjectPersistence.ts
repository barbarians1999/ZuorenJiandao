import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PlayerRef } from '@remotion/player';
import { revisionOf } from '../agent/external-edit-session';
import { useT } from '../i18n/locale';
import { acknowledgeSavedCaptionDrafts } from '../captions/captionDraftRecovery';
import {
  isExternalBridgeReadOnly,
  subscribeExternalBridgeReadOnly,
} from '../agent/external-bridge-registration';
import {
  flushProjectSaves,
  hasPendingProjectSaves,
  hasProjectSaveFailure,
  reloadProjectForEditing,
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
  onApplySyncedDoc?: (doc: ProjectDoc) => void;
}

interface EditorSaveControls {
  saveStatus: ProjectSaveStatus;
  saveError?: string;
  retrySave: () => Promise<boolean>;
}

const projectSaveStore = { saveProject, flushProjectSaves, hasPendingProjectSaves, hasProjectSaveFailure };
export type ProjectSaveStore = typeof projectSaveStore;

export function useEditorAutosave(
  projectId: string,
  doc: ProjectDoc,
  store: ProjectSaveStore = projectSaveStore,
  playerRef?: MutableRef<PlayerRef | null>,
): EditorSaveControls & { flushBeforeLeave: () => Promise<boolean>; discardPending: () => void } {
  const t = useT();
  const queue = useMemo(() => new ProjectAutosaveQueue(projectId, store.saveProject,
    (savedDoc) => acknowledgeSavedCaptionDrafts(projectId, savedDoc),
    (loadedDoc) => acknowledgeSavedCaptionDrafts(projectId, loadedDoc)), [projectId, store]);
  const feedback = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const saveFailureShownRef = useRef(false);
  const firstPendingEditAtRef = useRef<number | null>(null);
  const retryInFlightRef = useMemo(() => ({ current: null as Promise<boolean> | null }), [queue]);
  const readOnly = useSyncExternalStore(
    subscribeExternalBridgeReadOnly,
    () => isExternalBridgeReadOnly(projectId),
    () => false,
  );
  useEffect(() => {
    if (readOnly) {
      queue.discardPending();
      return undefined;
    }
    if (!queue.observe(doc)) return undefined;
    if (firstPendingEditAtRef.current === null) firstPendingEditAtRef.current = Date.now();
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let pausedPlayer: PlayerRef | null = null;
    const enqueueNow = () => {
      firstPendingEditAtRef.current = null;
      void queue.enqueue();
    };
    const onPause = () => {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(enqueueNow, 250);
    };
    const timer = setTimeout(() => {
      const player = playerRef?.current ?? null;
      let isPlaying = false;
      try { isPlaying = Boolean(player?.isPlaying?.()); } catch { isPlaying = false; }
      const ageMs = firstPendingEditAtRef.current !== null ? Date.now() - firstPendingEditAtRef.current : 0;
      if (isPlaying && player && ageMs < 10_000) {
        pausedPlayer = player;
        player.addEventListener('pause', onPause);
        capTimer = setTimeout(enqueueNow, Math.max(250, 10_000 - ageMs));
        return;
      }
      enqueueNow();
    }, 1200);
    return () => {
      clearTimeout(timer);
      clearTimeout(pauseTimer);
      clearTimeout(capTimer);
      if (pausedPlayer) pausedPlayer.removeEventListener('pause', onPause);
    };
  }, [doc, queue, playerRef, readOnly]);
  useEffect(() => {
    if (feedback.status === 'error' && !saveFailureShownRef.current) {
      showAppToast(t('工程保存失败，请点击顶部“重试保存”。内容仍保留在当前窗口，保存成功前请勿关闭。'), { error: true });
      saveFailureShownRef.current = true;
    } else if (feedback.status === 'saved') saveFailureShownRef.current = false;
  }, [feedback.status, t]);
  const retrySave = useCallback((): Promise<boolean> => {
    if (isExternalBridgeReadOnly(projectId)) return Promise.resolve(true);
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
  const discardPending = useCallback(() => { queue.discardPending(); }, [queue]);
  return { flushBeforeLeave, discardPending, saveStatus: feedback.status, saveError: feedback.error, retrySave };
}

function useBrowserSaveGuards(projectId: string, queue: ProjectAutosaveQueue, store: ProjectSaveStore): void {
  useEffect(() => {
    const flushWithoutWaiting = (): void => {
      if (isExternalBridgeReadOnly(projectId)) return;
      void queue.enqueue();
      void store.flushProjectSaves(projectId);
    };
    const blockUnfinishedSave = (event: BeforeUnloadEvent): void => {
      if (isExternalBridgeReadOnly(projectId)) return;
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
  docRef,
  playerRef,
  flushBeforeLeaveRef,
  onHome,
  onApplySyncedDoc,
}: EditorProjectPersistenceOptions): EditorSaveControls & { handleHome: () => Promise<void>; syncProject: () => Promise<void>; syncingProject: boolean } {
  const t = useT();
  const { flushBeforeLeave, discardPending, ...saveControls } = useEditorAutosave(projectId, doc, projectSaveStore, playerRef);
  flushBeforeLeaveRef.current = flushBeforeLeave;
  const [syncingProject, setSyncingProject] = useState(false);
  const syncInFlightRef = useRef(false);
  // usePlayheadPaint owns per-timeline resume. A second seek here used to
  // overwrite the restored position with zero after every subdraft switch.

  const handleHome = useCallback(async (): Promise<void> => {
    if (isExternalBridgeReadOnly(projectId)) {
      discardPending();
      onHome();
      return;
    }
    if (await flushBeforeLeave()) onHome();
  }, [discardPending, flushBeforeLeave, onHome, projectId]);

  const syncProject = useCallback(async (): Promise<void> => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    setSyncingProject(true);
    try {
      if (saveControls.saveStatus === 'saving') {
        await saveControls.retrySave();
      }
      const result = await reloadProjectForEditing(projectId);
      if (result.status === 'unreadable') {
        showAppToast(t('同步工程失败：暂时无法读取本机工程数据，当前编辑内容已保留'), { error: true });
        return;
      }
      if (result.status === 'missing') {
        showAppToast(t('同步工程失败：未找到已保存的工程记录，当前编辑内容已保留'), { error: true });
        return;
      }
      if (revisionOf(result.doc) === revisionOf(docRef.current) && saveControls.saveStatus !== 'error') {
        showAppToast(t('工程已是最新版本'));
        return;
      }
      discardPending();
      onApplySyncedDoc?.(result.doc);
      showAppToast(t('已同步最新工程'));
    } finally {
      syncInFlightRef.current = false;
      setSyncingProject(false);
    }
  }, [discardPending, docRef, onApplySyncedDoc, projectId, saveControls, t]);

  return { handleHome, syncProject, syncingProject, ...saveControls };
}
