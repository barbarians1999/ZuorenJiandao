import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { theme, themeAlpha } from '../../theme';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { CURRENT_APP_VERSION, formatDisplayVersion } from '../../ui/upstreamUpdate';
import { setAutoTranscribeIngest } from '../../transcript/provider';
import { loadMcpGuideDialog } from './mcpGuideLoader';
import { LocalCaptionSettings } from './LocalCaptionSettings';
import { LocalModelPackPane } from './LocalModelPackPane';
import { SemanticModelPackPane } from './SemanticModelPackPane';

const inputStyle: CSSProperties = { padding: '7px 9px', border: `1px solid ${theme.border}`, borderRadius: 5, background: theme.panelAlt, color: theme.text, font: 'inherit', width: '100%' };
const buttonStyle: CSSProperties = { padding: '7px 16px', border: `1px solid ${theme.border}`, borderRadius: 5, background: theme.panelAlt, color: theme.text, cursor: 'pointer' };
const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((module) => ({ default: module.McpGuideDialog })));
type SettingsSnapshot = { models?: Record<string, string>; dataDir?: string; mediaDir?: string; restartRequired?: boolean };

export function SettingsDialog({ onClose, initialVendor }: { onClose: () => void; initialVendor?: string }) {
  const t = useT();
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
  return (
    <div role="presentation" onMouseDown={close} style={{ position: 'fixed', inset: 0, zIndex: 2000, display: 'grid', placeItems: 'center', background: themeAlpha.shadow(0.53) }}>
      <section className="cc-settings-readable" role="dialog" aria-modal="true" aria-label={t('设置')} onMouseDown={(event) => event.stopPropagation()} style={{ width: 'min(820px, 94vw)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', borderRadius: 8, border: `1px solid ${theme.border}`, background: theme.panel, color: theme.text, fontSize: 15 }}>
        <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${theme.border}` }}>
          <Icon name="sliders" size={16} /><b>{t('设置')}</b>
          <span style={{ marginLeft: 'auto', color: theme.textDim }}>{formatDisplayVersion(CURRENT_APP_VERSION)}</span>
          <button aria-label={t('关闭')} onClick={close} style={buttonStyle}><Icon name="x" size={14} /></button>
        </header>
        <nav style={{ display: 'flex', gap: 8, padding: '12px 18px', borderBottom: `1px solid ${theme.border}` }}>
          {['常规', '本地工具', '外部控制'].map((name) => <button key={name} onClick={() => setPage(name)} style={{ ...buttonStyle, color: page === name ? theme.accent : theme.text }}>{t(name)}</button>)}
        </nav>
        <div style={{ padding: 18, overflow: 'auto', minHeight: 260 }}>
          {page === '常规' && <div style={{ display: 'grid', gap: 16 }}>
            <label>{t('默认工程位置')}<input value={value('OPENCHATCUT_DATA_DIR')} onChange={(event) => stage('OPENCHATCUT_DATA_DIR', event.target.value)} placeholder={snapshot.dataDir} style={inputStyle} /></label>
            <small style={{ color: theme.textDim }}>{t('修改后会复制已有数据，重启后生效。')}</small>
            <label>{t('素材存储目录')}<input value={value('MEDIA_DIR')} onChange={(event) => stage('MEDIA_DIR', event.target.value)} placeholder={snapshot.mediaDir} style={inputStyle} /></label>
            <label>{t('界面缩放')}<select value={value('UI_SCALE') || '1'} onChange={(event) => stage('UI_SCALE', event.target.value)} style={inputStyle}>{['0.8','0.85','1','1.15','1.25','1.5'].map((scale) => <option key={scale} value={scale}>{Math.round(Number(scale) * 100)}%</option>)}</select></label>
            <label>{t('导入后自动转写')}<select value={value('AUTO_TRANSCRIBE_INGEST') || 'local'} onChange={(event) => stage('AUTO_TRANSCRIBE_INGEST', event.target.value)} style={inputStyle}><option value="local">{t('仅使用本地字幕识别')}</option><option value="off">{t('关闭')}</option></select></label>
          </div>}
          {page === '本地工具' && <div style={{ display: 'grid', gap: 22 }}>
            <LocalCaptionSettings selectedModel={value('LOCAL_ASR_MODEL')} onSelect={(model) => stage('LOCAL_ASR_MODEL', model)} />
            <LocalModelPackPane packIds={['rhythm-lite', 'music-semantics-lite']} />
            <SemanticModelPackPane />
          </div>}
          {page === '外部控制' && <section><p>{t('在 Codex 中下达剪辑命令，通过 MCP 操作当前工程。软件本身不运行聊天模型，也无需填写 AI API 密钥。')}</p><button style={buttonStyle} onClick={() => setShowGuide(true)}>{t('打开外部控制连接指南')}</button></section>}
        </div>
        <footer style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 18px', borderTop: `1px solid ${theme.border}` }}>
          <span role={error ? 'alert' : 'status'} style={{ color: error ? theme.danger : theme.textDim, flex: 1 }}>{error || message}</span>
          <button onClick={close} style={buttonStyle}>{t('关闭')}</button><button disabled={!dirty || busy} onClick={() => void save()} style={{ ...buttonStyle, color: theme.accent }}>{t(busy ? '保存中…' : '保存')}</button>
        </footer>
      </section>
    </div>
  );
}
