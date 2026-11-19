import { useSyncExternalStore } from 'react';
import { useT } from '../../i18n/locale';
import { getPreviewSourceMode, setPreviewSourceMode, subscribeQualityMode } from '../../media/qualityPolicy';
import { retryPreviewProxy, type PreviewProxyState } from '../../media/previewMedia';
import { theme } from '../../theme';

export function PreviewSourceToggle() {
  const t = useT();
  const mode = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  return <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
    <span>{t('预览画质')}</span>
    {(['original', 'proxy'] as const).map((value) => <button key={value} type="button"
      aria-pressed={mode === value} onClick={() => setPreviewSourceMode(value)}
      title={value === 'original' ? t('原片：检查画面细节') : t('流畅预览仅影响编辑播放，导出仍使用原素材')}
      style={{ fontSize: 11, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
        border: `1px solid ${theme.border}`, color: theme.text,
        background: mode === value ? theme.panelAlt : 'transparent' }}>
      {value === 'original' ? t('原片') : t('流畅')}
    </button>)}
    <details style={{ position: 'relative' }}>
      <summary title={t('更多预览选项')} style={{ cursor: 'pointer', listStyle: 'none', padding: '2px 6px', borderRadius: 999, border: `1px solid ${theme.border}`, background: theme.panelAlt }}>{mode === 'auto' ? t('自动') : '⋯'}</summary>
      <button type="button" aria-pressed={mode === 'auto'} onClick={() => setPreviewSourceMode('auto')}
        title={t('自动：跟随画质策略（画质优先=高清，均衡=流畅）')}>{t('自动')}</button>
    </details>
  </div>;
}

export function PreviewProxyStatus({ proxies }: { proxies: Array<{ src: string; proxy: PreviewProxyState }> }) {
  const t = useT();
  const mode = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  const failed = proxies.filter(({ proxy }) => proxy.status === 'failed');
  const pending = proxies.filter(({ proxy }) => proxy.status === 'loading').length;
  const ready = proxies.filter(({ proxy }) => proxy.status === 'ready').length;
  if (mode === 'original' || !proxies.length) return null;
  return <div role="status" aria-live="polite" style={{ fontSize: 11, display: 'flex', gap: 8,
    alignItems: 'center', flexWrap: 'wrap', padding: '4px 8px', color: theme.textMuted }}>
    <span>{t('流畅预览：准备中 {pending} · 已就绪 {ready} · 失败 {failed}',
      { pending, ready, failed: failed.length })}</span>
    {(pending > 0 || failed.length > 0) && <span>{t('未就绪素材暂用原片，不影响导出')}</span>}
    {failed.length > 0 && <>
      <button type="button" onClick={() => { for (const { src } of failed) void retryPreviewProxy(src); }}>{t('重试失败素材')}</button>
      <button type="button" onClick={() => setPreviewSourceMode('original')}>{t('切回原片')}</button>
    </>}
  </div>;
}
