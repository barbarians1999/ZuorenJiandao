import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DESKTOP_CLOSE_BEHAVIOR_KEY } from '../../../shared/desktop-close-behavior';
import { PROJECT_REPOSITORY_URL } from '../../../shared/project-repository';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import {
  CURRENT_APP_VERSION, formatDisplayVersion, getUpstreamUpdateState, hasDesktopUpdateSupport,
  requestUpstreamUpdateCheck, subscribeUpstreamUpdate,
} from '../../ui/upstreamUpdate';
import { resolveUpstreamUpdateAction, runUpstreamUpdateCommand, upstreamUpdateMessage } from '../../ui/upstreamUpdateAction';
import { setAutoTranscribeIngest } from '../../transcript/provider';
import { useExternalAutoApprove } from '../../agent/external-auto-approve';
import { loadMcpGuideDialog } from './mcpGuideLoader';
import { LocalCaptionSettings } from './LocalCaptionSettings';
import { LocalModelPackPane } from './LocalModelPackPane';
import { SemanticModelPackPane } from './SemanticModelPackPane';

const inputStyle: CSSProperties = {
  padding: '8px 12px', border: '1px solid transparent', borderRadius: 10,
  background: 'var(--cc-inset)', color: theme.text, font: 'inherit', width: '100%', boxSizing: 'border-box',
};
const buttonStyle: CSSProperties = {
  padding: '7px 16px', border: '1px solid transparent', borderRadius: 999,
  background: theme.panelAlt, color: theme.text, cursor: 'pointer', fontSize: 13, fontWeight: 550,
};
const browseBtnStyle: CSSProperties = {
  ...buttonStyle, padding: '8px 13px', display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
};
const closeBtnStyle: CSSProperties = {
  width: 30, height: 30, border: 'none', borderRadius: 999, background: theme.panelAlt,
  color: theme.textDim, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0,
};
const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((module) => ({ default: module.McpGuideDialog })));
type SettingsSnapshot = { models?: Record<string, string>; dataDir?: string; mediaDir?: string; restartRequired?: boolean };

function AboutSettings() {
  const t = useT();
  const update = useSyncExternalStore(subscribeUpstreamUpdate, getUpstreamUpdateState, getUpstreamUpdateState);
  const desktopUpdate = hasDesktopUpdateSupport();
  const action = resolveUpstreamUpdateAction(update, desktopUpdate);
  const busy = update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing';

  return (
    <section aria-label={t('关于')} style={{ display: 'grid', gap: 16 }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{t('左人剪刀')}</h2>
        <span style={{ color: theme.textDim, fontSize: 13 }}>
          {t('当前版本 {version}', { version: formatDisplayVersion(CURRENT_APP_VERSION) })}
        </span>
      </div>
      <a href={PROJECT_REPOSITORY_URL} target="_blank" rel="noopener noreferrer"
        style={{ color: theme.accent, width: 'fit-content' }}>{t('GitHub 仓库')}</a>
      <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" disabled={busy} onClick={() => void requestUpstreamUpdateCheck()}
            style={{ ...buttonStyle, opacity: busy ? 0.65 : 1, cursor: busy ? 'default' : 'pointer' }}>
            {update.phase === 'checking' ? t('检查中…') : t('检查更新')}
          </button>
          {action.command !== 'none' && action.command !== 'check' && (
            <button type="button" style={buttonStyle} onClick={() => runUpstreamUpdateCommand(action.command)}>{action.label}</button>
          )}
        </div>
        <div role="status" style={{ marginTop: 8, color: update.phase === 'error' ? theme.danger : theme.textDim, fontSize: 13 }}>
          {update.phase !== 'idle' && update.phase !== 'checking' ? upstreamUpdateMessage(update, desktopUpdate) : ''}
        </div>
      </div>
    </section>
  );
}

export function SettingsDialog({ onClose, initialVendor }: { onClose: () => void; initialVendor?: string }) {
  const t = useT();
  const [autoApproveExternal, setAutoApproveExternal] = useExternalAutoApprove();
  const [showGuide, setShowGuide] = useState(false);
  const [page, setPage] = useState(initialVendor?.includes('music') ? '本地工具' : '常规');
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dirty = Object.keys(values).length > 0;
  const close = () => {
    if (dirty && !window.confirm(t('有未保存改动，确定关闭？'))) return;
    onClose();
  };
  useEffect(() => {
    let alive = true;
    void fetch('/api/keys').then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const next = await response.json() as SettingsSnapshot;
      if (alive) setSnapshot(next);
    }).catch((reason: unknown) => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape' && !showGuide) close(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
  const value = (key: string) => values[key] ?? snapshot.models?.[key] ?? '';
  const stage = (key: string, next: string) => { setValues((current) => ({ ...current, [key]: next })); setMessage(''); };
  const canBrowseDir = typeof window !== 'undefined' && typeof window.openChatCutDesktop?.selectDirectory === 'function';
  const browseDir = async (key: string, fallback?: string) => {
    const picked = await window.openChatCutDesktop?.selectDirectory(value(key) || fallback || undefined);
    if (picked) stage(key, picked);
  };
  const save = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) });
      const next = await response.json() as SettingsSnapshot & { error?: string };
      if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
      setSnapshot(next);
      if (Object.hasOwn(values, 'LOCAL_ASR_MODEL')) {
        if (values.LOCAL_ASR_MODEL) localStorage.setItem('cc.asrModel', values.LOCAL_ASR_MODEL);
        else localStorage.removeItem('cc.asrModel');
      }
      if (Object.hasOwn(values, 'AUTO_TRANSCRIBE_INGEST')) setAutoTranscribeIngest(values.AUTO_TRANSCRIBE_INGEST === 'off' ? 'off' : 'local');
      await window.openChatCutDesktop?.windowAction('apply-ui-scale');
      setValues({}); setMessage(t(next.restartRequired ? '已保存，重启后生效' : '已保存'));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  if (showGuide) return <Suspense fallback={<div role="status">{t('加载中…')}</div>}><McpGuideDialog onClose={() => setShowGuide(false)} /></Suspense>;
  const dialog = (
    <div className="cc-settings-backdrop" role="presentation" onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'grid', placeItems: 'center', padding: '48px 16px 24px', background: themeAlpha.shadow(0.55) }}>
      <section className="cc-settings-readable" role="dialog" aria-modal="true" aria-label={t('设置')} onMouseDown={(event) => event.stopPropagation()} style={{ width: 'min(820px, 94vw)', maxHeight: 'calc(100vh - 72px)', display: 'flex', flexDirection: 'column', borderRadius: 18, border: '1px solid transparent', background: theme.panel, color: theme.text, fontSize: 15, boxShadow: `0 20px 56px ${themeAlpha.shadow(0.65)}`, overflow: 'hidden' }}>
        <header style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="sliders" size={16} /></span>
          <b>{t('设置')}</b>
          <button className="cc-settings-close" aria-label={t('关闭')} onClick={close} style={{ ...closeBtnStyle, marginLeft: 'auto' }}><Icon name="x" size={14} /></button>
        </header>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 18px', borderBottom: `1px solid ${theme.border}` }}>
          {['常规', '本地工具', '外部控制', '关于'].map((name) => (
            <button
              key={name}
              type="button"
              className={`cc-settings-nav-btn${page === name ? ' is-active' : ''}`}
              aria-pressed={page === name}
              onClick={() => setPage(name)}
              style={{
                ...buttonStyle,
                padding: '6px 14px',
                background: page === name ? theme.accent : theme.panelAlt,
                color: page === name ? theme.onAccent : theme.text,
                fontWeight: page === name ? 650 : 500,
              }}
            >
              {t(name)}
            </button>
          ))}
        </nav>
        <div style={{ padding: 18, overflow: 'auto', minHeight: 260 }}>
          {page === '常规' && <div style={{ display: 'grid', gap: 14 }}>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>{t('默认工程位置')}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="cc-settings-input" value={value('OPENCHATCUT_DATA_DIR')} onChange={(event) => stage('OPENCHATCUT_DATA_DIR', event.target.value)} placeholder={snapshot.dataDir} style={{ ...inputStyle, flex: 1 }} />
                {canBrowseDir && (
                  <button type="button" className="cc-settings-btn" onClick={() => void browseDir('OPENCHATCUT_DATA_DIR', snapshot.dataDir)} style={browseBtnStyle}>
                    <Icon name="folder" size={14} />{t('选择')}
                  </button>
                )}
              </span>
            </label>
            <small style={{ color: theme.textDim, marginTop: -6 }}>{t('修改后会复制已有数据，重启后生效。')}</small>
            <label style={{ display: 'grid', gap: 6 }}>
              <span>{t('素材存储目录')}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="cc-settings-input" value={value('MEDIA_DIR')} onChange={(event) => stage('MEDIA_DIR', event.target.value)} placeholder={snapshot.mediaDir} style={{ ...inputStyle, flex: 1 }} />
                {canBrowseDir && (
                  <button type="button" className="cc-settings-btn" onClick={() => void browseDir('MEDIA_DIR', snapshot.mediaDir)} style={browseBtnStyle}>
                    <Icon name="folder" size={14} />{t('选择')}
                  </button>
                )}
              </span>
            </label>
            <label style={{ display: 'grid', gap: 6 }}><span>{t('界面缩放')}</span><select className="cc-settings-input" value={value('UI_SCALE') || '1'} onChange={(event) => stage('UI_SCALE', event.target.value)} style={inputStyle}>{['0.8','0.85','1','1.15','1.25','1.5'].map((scale) => <option key={scale} value={scale}>{Math.round(Number(scale) * 100)}%</option>)}</select></label>
            {typeof window !== 'undefined' && window.openChatCutDesktop && (
              <label style={{ display: 'grid', gap: 6 }}>
                <span>{t('关闭窗口时')}</span>
                <select className="cc-settings-input" value={value(DESKTOP_CLOSE_BEHAVIOR_KEY) || 'ask'}
                  onChange={(event) => stage(DESKTOP_CLOSE_BEHAVIOR_KEY, event.target.value)} style={inputStyle}>
                  <option value="ask">{t('每次询问')}</option>
                  <option value="quit">{t('彻底关闭')}</option>
                  <option value="background">{t('隐藏后台')}</option>
                </select>
              </label>
            )}
            <label style={{ display: 'grid', gap: 6 }}><span>{t('导入后自动转写')}</span><select className="cc-settings-input" value={value('AUTO_TRANSCRIBE_INGEST') || 'local'} onChange={(event) => stage('AUTO_TRANSCRIBE_INGEST', event.target.value)} style={inputStyle}><option value="local">{t('仅使用本地字幕识别')}</option><option value="off">{t('关闭')}</option></select></label>
          </div>}
          {page === '本地工具' && <div style={{ display: 'grid', gap: 22 }}>
            <LocalCaptionSettings selectedModel={value('LOCAL_ASR_MODEL')} onSelect={(model) => stage('LOCAL_ASR_MODEL', model)} />
            <LocalModelPackPane packIds={['rhythm-lite']} />
            <SemanticModelPackPane />
          </div>}
          {page === '外部控制' && <section style={{ display: 'grid', gap: 16 }}>
            <p style={{ margin: 0 }}>{t('在 Codex 中下达剪辑命令，通过 MCP 操作当前工程。软件本身不运行聊天模型，也无需填写 AI API 密钥。')}</p>
            <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 14px', borderRadius: 12, background: theme.panelAlt, border: `1px solid ${theme.border}`, cursor: 'pointer' }}>
              <span style={{ display: 'grid', gap: 3 }}>
                <strong style={{ fontSize: 14 }}>{t('自动允许所有外部操作（免反复确认）')}</strong>
                <small style={{ color: theme.textDim, fontSize: 13, lineHeight: 1.45 }}>
                  {t('开启后，外部客户端发起的工程修改与工具调用将直接生效，不再逐步弹窗确认；随时可关闭恢复逐步确认。')}
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="cc-switch"
                checked={autoApproveExternal}
                onChange={(event) => setAutoApproveExternal(event.target.checked)}
                aria-label={t('自动允许所有外部操作')}
              />
            </label>
            <div>
              <button className="cc-settings-btn" style={buttonStyle} onClick={() => setShowGuide(true)}>{t('打开外部控制连接指南')}</button>
            </div>
          </section>}
          {page === '关于' && <AboutSettings />}
        </div>
        <footer style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 18px', borderTop: `1px solid ${theme.border}` }}>
          <span role={error ? 'alert' : 'status'} style={{ color: error ? theme.danger : theme.textDim, flex: 1, fontSize: 13 }}>{error || message}</span>
          <button className="cc-settings-btn" onClick={close} style={buttonStyle}>{t('关闭')}</button>
          {(page !== '关于' || dirty) && <button className="cc-settings-btn cc-settings-btn--primary" disabled={!dirty || busy} onClick={() => void save()} style={{ ...buttonStyle, background: theme.accent, color: theme.onAccent, fontWeight: 650, opacity: !dirty || busy ? 0.5 : 1, cursor: !dirty || busy ? 'default' : 'pointer' }}>{t(busy ? '保存中…' : '保存')}</button>}
        </footer>
      </section>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(dialog, document.body) : dialog;
}
