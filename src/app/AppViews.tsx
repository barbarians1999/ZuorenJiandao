import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Dashboard } from '../components/Dashboard';
import type { ProjectDoc } from '../editor/types';
import { useT } from '../i18n/locale';
import { loadProjectForEditing, renameProject } from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { theme } from '../theme';
import { editorTabIdentity } from '../agent/external-bridge-registration';
import { emptyProjectDoc, navigateTo, type AppRoute } from './appShell';
import { useDashboardActions } from './useDashboardActions';
import { projectEditorHash, type ProjectQuickStart } from './projectQuickStart';

let editorModule: Promise<typeof import('../Editor')> | undefined;

function loadEditor() {
  return editorModule ??= import('../Editor').catch((error: unknown) => {
    editorModule = undefined;
    throw error;
  });
}

function warmEditor(): void {
  void loadEditor().catch(() => undefined);
}

const Editor = lazy(loadEditor);

export function AppSplash({ text }: { text: string }) {
  return (
    <div style={{
      height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg,
      color: theme.textDim, fontFamily: 'var(--cc-ui-font)', fontSize: 13,
    }}>
      {text}
    </div>
  );
}

interface EditorLoaderProps {
  meta: ProjectMeta;
  quickStart?: ProjectQuickStart;
  onHome: () => void;
  onRename: (name: string) => void;
  onRefreshMeta?: () => Promise<void>;
}

type EditorLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: ProjectDoc; syncKey: number }
  | { kind: 'unreadable' };

function EditorLoader({ meta, quickStart, onHome, onRename, onRefreshMeta }: EditorLoaderProps) {
  const t = useT();
  const [load, setLoad] = useState<EditorLoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    warmEditor();
    void loadProjectForEditing(meta.id).then((result) => {
      if (!alive) return;
      // "missing" opens a legitimately empty project; "unreadable" must block
      // the editor — opening it empty would let autosave overwrite real data.
      if (result.status === 'ok') setLoad({ kind: 'ready', doc: result.doc, syncKey: 0 });
      else if (result.status === 'missing') setLoad({ kind: 'ready', doc: emptyProjectDoc(), syncKey: 0 });
      else setLoad({ kind: 'unreadable' });
    });
    return () => { alive = false; };
  }, [meta.id, attempt]);
  if (load.kind === 'loading') return <AppSplash text={t('加载工程…')} />;
  if (load.kind === 'unreadable') {
    return (
      <div style={{
        height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg,
        fontFamily: 'var(--cc-ui-font)',
      }}>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'center', maxWidth: 420, textAlign: 'center' }}>
          <b style={{ color: theme.text, fontSize: 14 }}>{t('工程数据暂时无法读取')}</b>
          <span style={{ color: theme.textDim, fontSize: 12.5, lineHeight: 1.6 }}>
            {t('为避免覆盖已保存的内容，已停止打开该工程。数据仍保留在本机存储中，可稍后重试。')}
          </span>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: `0.5px solid ${theme.border}`,
                background: theme.accent, color: theme.bg, fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {t('重试')}
            </button>
            <button
              type="button"
              onClick={onHome}
              style={{
                padding: '6px 14px', borderRadius: 6, border: `0.5px solid ${theme.border}`,
                background: 'transparent', color: theme.text, fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {t('返回工程列表')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  const handleApplySyncedDoc = (doc: ProjectDoc) => {
    setLoad((prev) => ({ kind: 'ready', doc, syncKey: prev.kind === 'ready' ? prev.syncKey + 1 : 1 }));
    void onRefreshMeta?.();
  };
  return (
    <Suspense fallback={<AppSplash text={t('加载编辑器…')} />}>
      <Editor key={`${meta.id}:${load.syncKey}`} initial={load.doc} project={meta} quickStart={quickStart} onHome={onHome} onRename={onRename} onApplySyncedDoc={handleApplySyncedDoc} />
    </Suspense>
  );
}

interface EditorRouteProps {
  route: Extract<AppRoute, { name: 'editor' }>;
  projects: ProjectMeta[];
  refresh: () => Promise<void>;
}

export function EditorRoute({ route, projects, refresh }: EditorRouteProps) {
  const t = useT();
  const [checkedId, setCheckedId] = useState<string | null>(null);
  const meta = projects.find((project) => project.id === route.id);
  useEffect(() => {
    if (meta || checkedId === route.id) return;
    let alive = true;
    void refresh().finally(() => {
      if (alive) setCheckedId(route.id);
    });
    return () => { alive = false; };
  }, [checkedId, meta, refresh, route.id]);
  if (!meta) {
    if (checkedId !== route.id) return <AppSplash text={t('加载工程…')} />;
    navigateTo('#/');
    return <AppSplash text={t('工程不存在，返回…')} />;
  }
  return (
    <EditorLoader
      key={meta.id}
      meta={meta}
      quickStart={route.quickStart}
      onHome={() => navigateTo('#/')}
      onRename={async (name) => { await renameProject(meta.id, name); refresh(); }}
      onRefreshMeta={refresh}
    />
  );
}

export function DashboardRoute({
  projects,
  refresh,
}: {
  projects: ProjectMeta[];
  refresh: () => Promise<void>;
}) {
  const actions = useDashboardActions(refresh);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const hasProjects = projects.length > 0;
  useEffect(() => {
    if (editorModule) return;
    if (window.requestIdleCallback) {
      const idle = window.requestIdleCallback(warmEditor);
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(warmEditor, 200);
    return () => window.clearTimeout(timer);
  }, [hasProjects]);
  useEffect(() => {
    const syncIfVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', syncIfVisible);
    const timer = window.setInterval(syncIfVisible, 5_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', syncIfVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    const identity = editorTabIdentity();
    const controller = new AbortController();
    const poll = async () => {
      while (alive && !controller.signal.aborted) {
        try {
          const query = new URLSearchParams({
            clientId: identity.tabId,
            clientKind: identity.clientKind,
          });
          const res = await fetch(`/api/external-agent/dashboard-poll?${query}`, {
            signal: controller.signal,
          });
          if (res.status === 200) {
            const payload = await res.json() as { openProjectId?: string };
            if (alive && payload.openProjectId) {
              await refreshRef.current();
              if (!alive) return;
              navigateTo(projectEditorHash(payload.openProjectId));
              return;
            }
          }
          if (res.status !== 204 && res.status !== 200) {
            await new Promise((r) => setTimeout(r, 2_000));
          }
        } catch {
          if (!alive || controller.signal.aborted) break;
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    };
    void poll();
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);
  return <Dashboard projects={projects} {...actions} />;
}
