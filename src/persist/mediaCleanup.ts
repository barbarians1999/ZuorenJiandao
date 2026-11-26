// Asset reference inventory and cleaning. Solve two things:
// ① When deleting a project, cascade delete assets - but only delete files that are "no longer referenced by other projects" (copied project sharing
// Assets with the same name, reference counting ensures that they are not accidentally killed);
// ② Unowned asset cleaning - test/deleted project files left in /media/uploads/, click "All Project Documents"
// (Including soft deletion, which can be restored and counted as a reference) Find out the reference set and delete it after confirmation.
// Disk deletion goes through DELETE /upload (single segment security name on the server side); IDB media cache is cleared synchronously.
// R2 cloud objects are deliberately not moved: local deletion is reversible (it can still be retrieved when returning to the source).
import { deleteMediaBlob } from './mediaBlobStore';
import { listPacks } from '../plugins/store';
import { loadProject, purgeProject } from './projectStore';
import { kvEntriesForCleanup } from './sharedKv';
import { collectUploadSrcs, rawUploadSrcs } from './projectTransfer';

const MEDIA_PREFIX = '/media/uploads/';

export interface UploadFileInfo {
  name: string;
  bytes: number;
  mtimeMs: number;
}
export interface UnreferencedSourceCandidate extends UploadFileInfo {
  kind: 'unreferenced-source';
  autoDelete: false;
}

/** Disk list (server scans the upload directory; dev has the same API as the desktop). */
export async function listUploadFiles(): Promise<UploadFileInfo[]> {
  const res = await fetch('/upload/list');
  if (!res.ok) throw new Error(`/upload/list → HTTP ${res.status}`);
  const body = (await res.json()) as { files?: UploadFileInfo[] };
  return Array.isArray(body.files) ? body.files : [];
}

/** Union of all references = project document (one ID can be excluded - the deleted project itself is excluded during cascade deletion)
 * ∪ Upload the LUT cube with the extension package installed (the reference is recorded in the shared extension storage, not in the project document. If it is missed, it will be accidentally killed).*/
export async function collectAllUploadRefs(excludeId?: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const [key, value] of Object.entries(await kvEntriesForCleanup())) {
    if (excludeId && (key === `project:${excludeId}` || key === `project-legacy-backup:${excludeId}` || key === `local:project:${excludeId}`)) continue;
    const remaining: unknown[] = [value];
    const visited = new WeakSet<object>();
    while (remaining.length) {
      const part = remaining.pop();
      if (typeof part === 'string' && part.startsWith(MEDIA_PREFIX)) {
        const src = part.split(/[?#]/)[0]!;
        if (/^\/media\/uploads\/[^/\\\x00-\x1f\x7f]+$/.test(src)) {
          refs.add(src);
          try {
            const decoded = decodeURIComponent(src);
            if (/^\/media\/uploads\/[^/\\\x00-\x1f\x7f]+$/.test(decoded)) refs.add(decoded);
          } catch { /* A literal percent character is a valid file name. */ }
        }
      } else if (part && typeof part === 'object' && !visited.has(part)) {
        visited.add(part);
        if ('kind' in part && part.kind === 'quarantined-project-store-entry') {
          throw new Error('存在未能读取的工程，无法安全清理素材。请先恢复该工程。');
        }
        for (const child of Object.values(part)) remaining.push(child);
      }
    }
    // Raw snapshots also protect versions, recoverable exports, and orphan documents.
    for (const src of rawUploadSrcs(value)) refs.add(src);
  }
  for (const pack of await listPacks({ strict: true })) {
    for (const url of Object.values(pack.cubeUrls ?? {})) {
      if (url.startsWith(MEDIA_PREFIX)) refs.add(url);
    }
  }
  return refs;
}

/** Pure function: disk list − reference set = no owner file.*/
export function unreferencedOf(files: UploadFileInfo[], refs: Set<string>): UploadFileInfo[] {
  return files.filter((f) => !refs.has(MEDIA_PREFIX + f.name));
}

/** Delete an uploaded file (disk + IDB cache). Returns whether the server confirms.*/
export async function deleteUploadFile(name: string): Promise<boolean> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  // Only drop the browser cache copy once the server confirms the disk file is
  // gone. Deleting it after a rejected DELETE would remove one of the three
  // fallback layers while the file itself still exists.
  if (res.ok) await deleteMediaBlob(MEDIA_PREFIX + name).catch(() => {});
  return res.ok;
}

export interface CleanupScan {
  orphanDocsPurged: number;
  /** Backward-compatible candidate list used by the existing confirmation dialog. */
  files: UnreferencedSourceCandidate[];
  sourceCandidates: UnreferencedSourceCandidate[];
}

/** Pure decision: which project docs are orphans safe to purge. An empty index
 * while docs exist means the index itself is lost or unreadable (listProjects
 * degrades to [] on any read error) — treating every doc as an orphan then
 * would permanently destroy all projects, so nothing qualifies. */
export function orphanDocIdsToPurge(
  indexedIds: ReadonlySet<string>,
  docIds: readonly string[],
): string[] {
  if (indexedIds.size === 0 && docIds.length > 0) return [];
  return docIds.filter((id) => !indexedIds.has(id));
}

/** Scanning is read-only. An incomplete index does not prove a document is disposable. */
export async function scanUnreferenced(): Promise<CleanupScan> {
  const [files, refs] = await Promise.all([listUploadFiles(), collectAllUploadRefs()]);
  const sourceCandidates = unreferencedOf(files, refs).map((file) => ({
    ...file,
    kind: 'unreferenced-source' as const,
    autoDelete: false as const,
  }));
  return { orphanDocsPurged: 0, files: sourceCandidates, sourceCandidates };
}

/** Delete the project + cascade to delete its exclusive assets (reserved assets that are also referenced by other projects).*/
export async function purgeProjectCascade(id: string): Promise<{ filesDeleted: number; mediaCleanupSkipped?: boolean }> {
  const doc = await loadProject(id);
  const own = doc ? collectUploadSrcs(doc) : [];
  await purgeProject(id);
  let filesDeleted = 0;
  if (own.length) {
    try {
      const refs = await collectAllUploadRefs();
      for (const src of own) {
        if (refs.has(src)) continue;
        if (await deleteUploadFile(src.slice(MEDIA_PREFIX.length))) filesDeleted += 1;
      }
    } catch (error) {
      console.warn('[mediaCleanup] post-purge asset cleanup skipped:', error);
      return { filesDeleted, mediaCleanupSkipped: true };
    }
  }
  return { filesDeleted };
}
