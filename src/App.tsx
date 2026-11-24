
import { useT } from './i18n/locale';
import {
  useAgentBackendSync,
  useAppRoute,
  useProjects,
} from './app/appShell';
import { AppSplash, DashboardRoute, EditorRoute } from './app/AppViews';
import { useInferenceWarmup } from './hooks/useInferenceWarmup';
import { useUiScaleShortcuts } from './hooks/useUiScaleShortcuts';
import { WindowCloseConfirmDialog } from './components/WindowCloseConfirmDialog';

export default function App() {
  const t = useT();
  const route = useAppRoute();
  useAgentBackendSync();
  useInferenceWarmup(route.name === 'editor');
  useUiScaleShortcuts();
  const { projects, refresh } = useProjects();

  return (
    <>
      {!projects
        ? <AppSplash text={t('加载中…')} />
        : route.name === 'editor'
          ? <EditorRoute route={route} projects={projects} refresh={refresh} />
          : <DashboardRoute projects={projects} refresh={refresh} />}
      <WindowCloseConfirmDialog />
    </>
  );
}
