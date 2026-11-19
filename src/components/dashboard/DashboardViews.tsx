import { Suspense, useEffect } from 'react';
import type { ProjectMeta } from '../../persist/projectStoreCoordinators';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { DashboardHeaderLinks } from '../DashboardHeaderLinks';
import { BrandMark, Icon } from '../icons';
import { bindAction } from '../../shortcuts/actionRegistry';
// Opened on demand, so they load on demand — see dashboardDialogs.tsx.
import {
  McpGuideDialog, MediaCleanupDialog, SettingsDialog, ShortcutsDialog, StorageMigrationDialog,
} from './dashboardDialogs';
import { useDashboardDialogPrefetch } from './dashboardDialogLoaders';
import { StorageMigrationBanner } from '../settings/StorageMigrationBanner';
import { SkinPicker } from '../settings/SkinPicker';
import { ToolbarUtilities } from '../ToolbarUtilities';
import { TopBarIconButton } from '../TopBarIconButton';
import {
  card, importBtn, miniBtn, nameInput, searchBox, searchClear, searchEmpty, searchIcon, searchInput,
  thumb,
} from './dashboardStyles';
import { relativeProjectTime, type DashboardModel, type DashboardProps } from './useDashboardModel';
import './dashboard-ui.css';

function ProjectSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  return (
    <label style={searchBox}>
      <span style={searchIcon}><Icon name="search" size={13} /></span>
      <input
        type="search"
        aria-label={t('搜索工程')}
        placeholder={t('搜索工程')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onChange(''); }}
        autoComplete="off"
        spellCheck={false}
        style={searchInput}
      />
      {value && <button type="button" onClick={() => onChange('')} aria-label={t('清除搜索')} style={searchClear}><Icon name="x" size={12} /></button>}
    </label>
  );
}

export function DashboardTitlebarContent({ model }: { model: DashboardModel }) {
  const t = useT();
  return (
    <>
      <span role="img" aria-label={t('左人剪刀')} className="cc-dashboard-brand"><BrandMark size={22} /></span>
      <span style={{ color: theme.textDim, fontSize: 13 }}>{t('我的工程')}</span>
      <span className="cc-dashboard-header-actions">
        <ToolbarUtilities>
          <TopBarIconButton icon="plug" label={t('外部 Agent 接入 (MCP)')} onClick={() => model.setDialog('mcp', true)} />
          <TopBarIconButton icon="keyboard" label={t('编辑快捷键')} onClick={() => model.setDialog('shortcuts', true)} />
          <TopBarIconButton icon="database" label={t('数据存储')} onClick={() => model.setDialog('storage', true)} />
          <DashboardHeaderLinks />
        </ToolbarUtilities>
        <SkinPicker />
        <TopBarIconButton icon="sliders" label={t('设置')} onClick={() => model.setDialog('settings', true)} />
      </span>
    </>
  );
}

function ProjectToolbar({ projects, model }: { projects: ProjectMeta[]; model: DashboardModel }) {
  const t = useT();
  return (
    <div className="cc-dashboard-toolbar">
      <div className="cc-dashboard-heading">
        <h1>{t('工程')}</h1>
        <span>{t('继续剪辑，或导入同伴发来的工程')}</span>
      </div>
      {model.transfer.note && <span style={{ color: theme.textDim, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.transfer.note}</span>}
      <span className="cc-dashboard-toolbar-actions">
        <ProjectSearch value={model.query} onChange={model.setQuery} />
        <button className="cc-dashboard-action" onClick={() => model.setDialog('cleanup', true)} style={importBtn} title={t('清理所有工程都不引用的上传素材(测试/已删工程残留)')}><Icon name="trash" size={13} /> {t('清理素材')}</button>
        <span style={{ color: theme.textDim, fontSize: 12.5 }}>
          {model.normalizedQuery
            ? t('{n} / {total} 个', { n: model.visibleProjects.length, total: projects.length })
            : t('{n} 个', { n: projects.length })}
        </span>
      </span>
    </div>
  );
}

function ProjectName({ project, model, onOpen }: { project: ProjectMeta; model: DashboardModel; onOpen: (id: string) => void }) {
  const t = useT();
  if (model.rename.editingId === project.id) {
    return <input
      autoFocus
      value={model.rename.draft}
      onChange={(event) => model.rename.setDraft(event.target.value)}
      onBlur={model.rename.commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); model.rename.commit(); }
        if (event.key === 'Escape') model.rename.cancel();
      }}
      aria-label={`${t('重命名')}: ${project.name}`}
      className="cc-project-name-edit"
      style={nameInput}
    />;
  }
  return <button
    type="button"
    className="cc-project-name"
    onClick={() => onOpen(project.id)}
    title={t('打开 {name}', { name: project.name })}
    aria-label={t('打开 {name}', { name: project.name })}
  >{project.name}</button>;
}

function ProjectActions({ project, props, model }: { project: ProjectMeta; props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  if (model.rename.confirmId === project.id) {
    return <button
      type="button"
      onClick={() => {
        void model.transfer.run(props.onDelete(project.id).then(() => t('已永久删除「{name}」', { name: project.name })));
        model.rename.setConfirmId(null);
      }}
      disabled={model.transfer.busy}
      aria-label={`${t('确认删除')}: ${project.name}`}
      style={{ ...miniBtn, color: theme.danger }}
      title={t('彻底删除工程,并清掉只有它引用的素材文件')}
    >{t('确认删除')}</button>;
  }
  return (
    <>
      <button type="button" className="cc-project-mini-action" onClick={() => model.rename.start(project)} style={miniBtn} title={t('重命名')} aria-label={`${t('重命名')}: ${project.name}`}><Icon name="pencil" size={13} /></button>
      <button type="button" className="cc-project-mini-action" onClick={() => props.onDuplicate(project.id)} style={miniBtn} title={t('复制')} aria-label={`${t('复制')}: ${project.name}`}><Icon name="copy" size={13} /></button>
      <button type="button" className="cc-project-mini-action" onClick={() => void model.transfer.run(props.onExport(project.id, project.name))} disabled={model.transfer.busy} style={miniBtn} title={t('导出为流式 .ccproj(含素材,可在桌面版/其它机器导入)')} aria-label={`${t('导出为流式 .ccproj(含素材,可在桌面版/其它机器导入)')}: ${project.name}`}><Icon name="download" size={13} /></button>
      <button type="button" className="cc-project-mini-action" onClick={() => model.rename.setConfirmId(project.id)} style={miniBtn} title={t('删除')} aria-label={`${t('删除')}: ${project.name}`}><Icon name="trash" size={13} /></button>
    </>
  );
}

function ProjectCard({ project, props, model }: { project: ProjectMeta; props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  return (
    <div className="cc-project-card" style={card}>
      <button className="cc-project-card-thumb" onClick={() => props.onOpen(project.id)} style={thumb} title={t('打开 {name}', { name: project.name })}>
        {model.thumbs[project.id]
          ? <img src={model.thumbs[project.id]} alt="" draggable={false} loading="lazy" decoding="async" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
          : <span style={{ color: theme.borderLight, display: 'inline-flex' }}><Icon name="play" size={26} /></span>}
      </button>
      <div className="cc-project-row-main">
        <ProjectName project={project} model={model} onOpen={props.onOpen} />
        <span className="cc-project-updated">{relativeProjectTime(project.updatedAt, t)}</span>
        <div className="cc-project-row-actions"><ProjectActions project={project} props={props} model={model} /></div>
      </div>
    </div>
  );
}

function ProjectGrid({ props, model }: { props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  return (
    <>
      {model.visibleProjects.length > 0 && <>
        <div className="cc-project-list-heading" aria-hidden="true"><span /><span>{t('名称')}</span><span>{t('最近')}</span><span /></div>
        <div className="cc-project-grid" role="list">
          {model.visibleProjects.map((project) => <div role="listitem" key={project.id}><ProjectCard project={project} props={props} model={model} /></div>)}
        </div>
      </>}
      {!model.normalizedQuery && props.projects.length === 0 && <div className="cc-dashboard-empty"><strong>{t('新建工程')}</strong><span>{t('从空白时间线开始')}</span></div>}
      {model.normalizedQuery && model.visibleProjects.length === 0 && (
        <div role="status" style={searchEmpty}><Icon name="search" size={14} />{t('没有找到匹配“{query}”的工程', { query: model.query.trim() })}</div>
      )}
    </>
  );
}

export function DashboardContent({ props, model }: { props: DashboardProps; model: DashboardModel }) {
  const t = useT();
  return (
    <main className="cc-dashboard-main" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div className="cc-dashboard-content">
        <StorageMigrationBanner onOpenDialog={() => model.setDialog('storage', true)} />
        <div className="cc-dashboard-primary-actions">
          <button type="button" className="cc-dashboard-new-project" onClick={() => { void props.onNew(); }}><Icon name="plus" size={18} />{t('新建工程')}</button>
          <button type="button" className="cc-dashboard-import-project" onClick={() => model.transfer.fileRef.current?.click()} disabled={model.transfer.busy}><Icon name="upload" size={18} />{t('导入工程')}</button>
          <input ref={model.transfer.fileRef} type="file" accept=".ccproj,.json,application/json,application/x-openchatcut-project" onChange={model.transfer.pickImport} style={{ display: 'none' }} />
        </div>
        <ProjectToolbar projects={props.projects} model={model} />
        <ProjectGrid props={props} model={model} />
      </div>
    </main>
  );
}

export function DashboardDialogs({ model }: { model: DashboardModel }) {
  // The settings dialog's Anthropic pane summons the MCP guide through the
  // action registry; in the editor the top bar answers, here the dashboard's
  // own dialog state does. Without this the button silently does nothing on
  // the projects page, which is exactly where a new user starts.
  useEffect(() => bindAction('open-mcp-guide', () => model.setDialog('mcp', true)), [model]);
  useDashboardDialogPrefetch();
  return (
    // No fallback: a dialog that is still loading shows nothing, exactly as it
    // did before it was opened. The idle prefetch keeps that window tiny.
    <Suspense fallback={null}>
      {model.dialogs.settings && <SettingsDialog onClose={() => model.setDialog('settings', false)} />}
      {model.dialogs.shortcuts && <ShortcutsDialog onClose={() => model.setDialog('shortcuts', false)} />}
      {model.dialogs.mcp && <McpGuideDialog onClose={() => model.setDialog('mcp', false)} />}
      {model.dialogs.cleanup && <MediaCleanupDialog onClose={() => model.setDialog('cleanup', false)} />}
      {model.dialogs.storage && <StorageMigrationDialog onClose={() => model.setDialog('storage', false)} />}
    </Suspense>
  );
}
