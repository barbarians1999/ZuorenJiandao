import { lazy, Suspense, useState, useEffect, useSyncExternalStore } from 'react';
import { theme } from '../theme';
import { BrandMark, Icon } from './icons';
import { ExportHistory } from './ExportHistory';
import { loadMcpGuideDialog } from './settings/mcpGuideLoader';
import { useT } from '../i18n/locale';
import { invokeAction, bindAction } from '../shortcuts/actionRegistry';
import { getShortcutPreset, setShortcutPreset, SHORTCUT_PRESETS, subscribeKeymap } from '../shortcuts/keymap';
import { DesktopWindowControls } from './DesktopWindowControls';
import { TopBarIconButton } from './TopBarIconButton';
import { ToolbarUtilities } from './ToolbarUtilities';
import { ProjectSaveIndicator, type ProjectSaveIndicatorProps } from './ProjectSaveIndicator';
import { SkinPicker } from './settings/SkinPicker';
import './editorFeedback.css';

// Lazy, like the dashboard's copy of this dialog. A static import here put the
// whole MCP guide into the editor's eager chunk and made every lazy() built on
// loadMcpGuideDialog ineffective, dashboard included — both top bars have to go
// through the thunk for either to be split.
const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((m) => ({ default: m.McpGuideDialog })));

interface TopBarProps extends ProjectSaveIndicatorProps {
  projectId: string;
  projectName: string;
  canUndo: boolean;
  canRedo: boolean;
  exporting?: boolean;
  exportJobCount?: number;
  onHome?: () => void;
  onRename?: (name: string) => void;
  onSyncProject?: () => void;
  syncingProject?: boolean;
}

export function TopBar({ projectName, canUndo, canRedo, saveStatus = 'saved', saveError, onRetrySave, exporting, exportJobCount = 0, onHome, onRename, onSyncProject, syncingProject = false }: TopBarProps) {
  const t = useT();
  const isMacDesktop = window.openChatCutDesktop?.platform === 'darwin';
  const isWindowsDesktop = window.openChatCutDesktop?.platform === 'win32';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(projectName);
  const [mcpOpen, setMcpOpen] = useState(false);
  const shortcutPreset = useSyncExternalStore(subscribeKeymap, getShortcutPreset, getShortcutPreset);
  const shortcutPresetLabel = SHORTCUT_PRESETS.find(({ id }) => id === shortcutPreset)!.label;
  // The settings dialog (and anything else) can summon the MCP guide through the
  // action registry: the Anthropic pane names this panel as the way in for
  // Claude Code subscribers, so it has to be able to actually open it.
  useEffect(() => bindAction('open-mcp-guide', () => setMcpOpen(true)), []);
  const commit = () => { setEditing(false); if (onRename && draft.trim() && draft.trim() !== projectName) onRename(draft.trim()); };

  return (
    <header className={`cc-topbar cc-window-titlebar${isMacDesktop ? ' cc-window-titlebar--mac' : ''}${isWindowsDesktop ? ' cc-window-titlebar--windows' : ''}`} style={{ gridColumn: '1 / -1', gridRow: 1, position: 'relative', height: '100%', display: 'flex', alignItems: 'center', padding: '0 6px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel, gap: 4 }}>
      <DesktopWindowControls />
      <span className="cc-editor-brand-mark" aria-hidden="true"><BrandMark size={22} /></span>
      {/* Keep the project-list action separate from the brand mark. */}
      <button className="cc-topbar-home cc-tip" data-tip={t('返回工程列表')} aria-label={t('返回工程列表')} onMouseDown={(event) => event.preventDefault()} onClick={onHome}
        style={{ width: 36, height: 36, flexShrink: 0, border: 'none', borderRadius: 6, cursor: onHome ? 'pointer' : 'default', padding: 0, lineHeight: 0, display: 'grid', placeItems: 'center', color: theme.textDim }}
        onMouseEnter={(e) => { if (onHome) { e.currentTarget.style.color = theme.text; e.currentTarget.style.background = theme.panelAlt; } }}
        onMouseLeave={(e) => { e.currentTarget.style.color = theme.textDim; e.currentTarget.style.background = 'none'; }}>
        <Icon name="home" size={20} />
      </button>
      <span style={{ width: 1, height: 20, background: theme.border, margin: '0 4px' }} />

      {/* Flexible project title yields space to controls instead of overlapping them. */}
      <div className="cc-topbar-title" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, color: theme.text }} data-cc-titlebar-control="true">
        {editing ? (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setEditing(false); }}
            style={{ font: 'inherit', fontSize: 14, textAlign: 'center', background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.accent}`, borderRadius: 5, padding: '2px 8px', minWidth: 200 }} />
        ) : (
          <>
            <span onDoubleClick={() => { if (onRename) { setDraft(projectName); setEditing(true); } }} title={onRename ? t('双击重命名') : undefined} style={{ cursor: onRename ? 'text' : 'default' }}>{projectName}</span>
            <ProjectSaveIndicator {...{ saveStatus, saveError, onRetrySave }} />
          </>
        )}
      </div>

      <div className="cc-topbar-actions">

      {/* right: undo · redo · shortcuts · history · layout · export · avatar */}
      <TopBarIconButton icon="undo" label={t('撤销')} onClick={() => invokeAction('undo', undefined, 'toolbar')} disabled={!canUndo} />
      <TopBarIconButton icon="redo" label={t('重做')} onClick={() => invokeAction('redo', undefined, 'toolbar')} disabled={!canRedo} />
      {onSyncProject && (
        <TopBarIconButton
          icon="refresh"
          label={syncingProject ? t('正在同步工程…') : t('同步工程')}
          onClick={onSyncProject}
          disabled={syncingProject}
        />
      )}
      <span className="cc-editor-settings-entry">
        <TopBarIconButton icon="sliders" label={t('设置')} onClick={() => invokeAction('open-settings', undefined, 'toolbar')} />
      </span>
      <SkinPicker />
      <ToolbarUtilities icon="keyboard" label={t('快捷键方案')} triggerText={t(shortcutPresetLabel)}>
        {SHORTCUT_PRESETS.map(({ id, label }) => (
          <TopBarIconButton key={id} icon={id === shortcutPreset ? 'check' : 'keyboard'} label={t(label)}
            pressed={id === shortcutPreset} onClick={() => {
              setShortcutPreset(id);
              if (id === 'custom') invokeAction('keyboard-shortcuts', undefined, 'toolbar');
            }} />
        ))}
      </ToolbarUtilities>
      <span id="cc-agent-change-log-slot" style={{ display: 'contents' }} />
      <div className="cc-topbar-utility-cluster">
      {/* This dialog owns transient state and must remain mounted while its overlay is open. */}
      <ExportHistory />
      <ToolbarUtilities>
        <TopBarIconButton icon="history" label={t('历史版本')} onClick={() => invokeAction('open-history', undefined, 'toolbar')} />
        <TopBarIconButton icon="layoutPanel" label={t('切换面板布局')} onClick={() => invokeAction('toggle-layout', undefined, 'toolbar')} />
        <TopBarIconButton icon="plug" label={t('外部 Agent 接入 (MCP)')} onClick={() => setMcpOpen(true)} />
        <TopBarIconButton icon="palette" label={t('设计风格(品牌)')} onClick={() => invokeAction('open-design', undefined, 'toolbar')} />
      </ToolbarUtilities>
      </div>
      <button onMouseDown={(event) => event.preventDefault()} onClick={() => invokeAction('open-export', undefined, 'toolbar')}
        className="cc-topbar-export cc-tip cc-tip-r"
        data-tip={exporting ? t('查看后台导出任务') : t('导出')}
        aria-label={exporting ? t('查看后台导出任务') : t('导出')}
        style={{ minWidth: 88, height: 34, background: 'var(--cc-heading-bg)', color: 'var(--cc-heading-ink)', border: 'none', borderRadius: 999, padding: '0 20px', fontSize: 14, fontWeight: 650, letterSpacing: '0.02em', cursor: 'pointer', marginLeft: 8 }}>
        {exporting ? t('{n} 个导出', { n: Math.max(1, exportJobCount) }) : t('导出')}
      </button>
      </div>
      {/* No fallback: a dialog that is still loading shows nothing, exactly as it
          did before it was opened — the same treatment the other overlays get. */}
      <Suspense fallback={null}>
        {mcpOpen && <McpGuideDialog onClose={() => setMcpOpen(false)} />}
      </Suspense>
    </header>
  );
}
