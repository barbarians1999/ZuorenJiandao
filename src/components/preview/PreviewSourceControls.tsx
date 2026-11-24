import { useSyncExternalStore } from 'react';
import { useT } from '../../i18n/locale';
import { getPreviewSourceMode, setPreviewSourceMode, subscribeQualityMode } from '../../media/qualityPolicy';
import { retryPreviewProxy, type PreviewProxyState } from '../../media/previewMedia';
import { theme } from '../../theme';

export function PreviewSourceToggle() {
  const t = useT();
  const mode = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  return (
    <select
      className="cc-branded-select cc-preview-quality-select"
      aria-label={t('预览画质')}
      title={t('预览画质（仅影响编辑播放，不影响导出）')}
      value={mode}
      onChange={(event) => setPreviewSourceMode(event.target.value as 'auto' | 'original' | 'proxy')}
    >
      <option value="auto">{t('画质：自动')}</option>
      <option value="original">{t('画质：原片')}</option>
      <option value="proxy">{t('画质：流畅')}</option>
    </select>
  );
}

export function PreviewProxyStatus({ proxies }: { proxies: Array<{ src: string; proxy: PreviewProxyState }> }) {
  const t = useT();
  const mode = useSyncExternalStore(subscribeQualityMode, getPreviewSourceMode, getPreviewSourceMode);
  const failed = proxies.filter(({ proxy }) => proxy.status === 'failed');
  const pending = proxies.filter(({ proxy }) => proxy.status === 'loading').length;
  const ready = proxies.filter(({ proxy }) => proxy.status === 'ready').length;
  if (mode === 'original' || !proxies.length) return null;
  if (pending === 0 && failed.length === 0) return null;
  return (
    <div role="status" aria-live="polite" className="cc-preview-proxy-status" style={{ fontSize: 11, display: 'flex', gap: 8,
      alignItems: 'center', flexWrap: 'wrap', padding: '4px 10px', color: theme.textMuted }}>
      <span>
        {failed.length > 0
          ? t('流畅代理：准备 {pending} · 就绪 {ready} · 失败 {failed}', { pending, ready, failed: failed.length })
          : t('流畅代理：准备中 {pending} · 已就绪 {ready}', { pending, ready })}
      </span>
      {failed.length > 0 && (
        <>
          <button type="button" onClick={() => { for (const { src } of failed) void retryPreviewProxy(src); }}>{t('重试')}</button>
          <button type="button" onClick={() => setPreviewSourceMode('original')}>{t('切回原片')}</button>
        </>
      )}
    </div>
  );
}
