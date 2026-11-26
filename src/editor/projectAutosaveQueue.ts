import { pendingAutosaveAfterObservation, recoverFailedAutosave } from '../persist/autosaveRecovery';
import type { ProjectSaveResult } from '../persist/projectStoreCoordinators';
import type { ProjectDoc } from './types';

export type ProjectSaveStatus = 'saved' | 'saving' | 'error';
export interface ProjectSaveFeedback { status: ProjectSaveStatus; error?: string }
type PendingSave = { projectId: string; doc: ProjectDoc };

/** Owns the exact unsaved snapshot, including failed writes. Retry never needs
 * a dummy edit, and an older completion cannot replace newer pending work. */
export class ProjectAutosaveQueue {
  private previous: PendingSave | null = null;
  private pending: PendingSave | null = null;
  private latestAttempt = 0;
  private feedback: ProjectSaveFeedback = { status: 'saved' };
  private readonly listeners = new Set<() => void>();
  private readonly projectId: string;
  private readonly save: (projectId: string, doc: ProjectDoc) => Promise<ProjectSaveResult>;
  private readonly onSaved?: (doc: ProjectDoc) => void;
  private readonly onLoaded?: (doc: ProjectDoc) => void;

  constructor(projectId: string, save: (projectId: string, doc: ProjectDoc) => Promise<ProjectSaveResult>,
    onSaved?: (doc: ProjectDoc) => void, onLoaded?: (doc: ProjectDoc) => void) {
    this.projectId = projectId;
    this.save = save;
    this.onSaved = onSaved;
    this.onLoaded = onLoaded;
  }

  getSnapshot = (): ProjectSaveFeedback => this.feedback;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  hasPending = (): boolean => this.pending !== null;

  /** Drop any queued or failed snapshot when explicitly adopting an external revision. */
  discardPending(): void {
    this.pending = null;
    this.publish({ status: 'saved' });
  }

  private publish(feedback: ProjectSaveFeedback): void {
    if (feedback.status === this.feedback.status && feedback.error === this.feedback.error) return;
    this.feedback = feedback;
    for (const listener of this.listeners) listener();
  }

  observe(doc: ProjectDoc): boolean {
    const initial = this.previous === null;
    const next = { projectId: this.projectId, doc };
    const pending = pendingAutosaveAfterObservation(this.previous, next);
    this.previous = next;
    if (initial) {
      try { this.onLoaded?.(doc); } catch { /* Recovery cleanup must not affect project loading. */ }
    }
    // An effect replay must not discard a failed snapshot awaiting retry.
    if (!pending) return false;
    this.pending = pending;
    this.publish({ status: 'saving' });
    return true;
  }

  enqueue = (): Promise<ProjectSaveResult> | null => {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    const attempt = ++this.latestAttempt;
    this.publish({ status: 'saving' });
    let saving: Promise<ProjectSaveResult>;
    try { saving = this.save(pending.projectId, pending.doc); }
    catch (error) { saving = Promise.reject(error); }
    return saving.catch((error): ProjectSaveResult => ({
      projectId: pending.projectId, revision: 0, epoch: 0,
      status: 'failed', saved: false, indexUpdated: false, error,
    })).then((result) => {
      if (result.status === 'failed') {
        this.pending = recoverFailedAutosave({ currentUnsaved: this.pending, failedSnapshot: pending,
          failedAttempt: attempt, latestEnqueuedAttempt: this.latestAttempt });
      }
      if (attempt !== this.latestAttempt) return result;
      if (result.status === 'failed' && this.pending === pending) {
        const error = result.error instanceof Error ? result.error.message : String(result.error ?? '');
        this.publish({ status: 'error', error });
      } else {
        this.publish({ status: this.pending ? 'saving' : 'saved' });
        if (result.status === 'saved' && !this.pending) {
          try { this.onSaved?.(pending.doc); } catch { /* Recovery cleanup must not change the save result. */ }
        }
      }
      return result;
    });
  };
}
