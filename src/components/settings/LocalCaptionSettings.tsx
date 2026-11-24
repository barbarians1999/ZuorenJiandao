import { useCallback, useEffect, useState } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import type { AsrDownloadTask } from '../../../shared/asr-models';
import { mutateLocalAsrModel } from './local-asr-model-mutation';

interface ModelStatus { id: string; label: string; sizeLabel: string; downloaded: boolean; task?: AsrDownloadTask }

/** Local speech recognition is an editing utility, not an LLM provider. */
export function LocalCaptionSettings({ selectedModel, onSelect }: { selectedModel: string; onSelect: (model: string) => void }) {
  const t = useT();
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/asr-models', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as { models: ModelStatus[] };
      setModels(body.models); setError('');
    } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const mutate = async (action: 'download' | 'delete', model: ModelStatus) => {
    if (action === 'delete' && !window.confirm(t('确定删除本地模型？'))) return;
    setBusyId(model.id);
    try { await mutateLocalAsrModel(action, model.id); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusyId(null); }
  };
  return <section style={{ display: 'grid', gap: 10 }}>
    <b>{t('本地字幕识别')}</b><small style={{ color: theme.textDim }}>{t('在本机运行，不需要 API 密钥。模型仅在点击下载后安装。')}</small>
    <label>{t('字幕模型')}<select className="cc-branded-select" value={selectedModel} onChange={(event) => onSelect(event.target.value)} style={{ marginLeft: 10, color: theme.text, background: 'var(--cc-inset)', border: '1px solid var(--cc-border)', borderRadius: 10, padding: '6px 12px', cursor: 'pointer' }}>
      <option value="">{t('自动选择')}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
    </select></label>
    {error && <span role="alert" style={{ color: theme.danger }}>{error}</span>}
    {models.map((model) => <div key={model.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${theme.border}` }}>
      <span style={{ flex: 1 }}>{model.label} <small style={{ color: theme.textDim }}>{model.sizeLabel}</small></span>
      <small>{model.task?.status === 'downloading' ? `${Math.round((model.task.bytesDone / Math.max(1, model.task.bytesTotal)) * 100)}%` : t(model.downloaded ? '已安装' : '未安装')}</small>
      <button disabled={busyId !== null || model.task?.status === 'downloading'} onClick={() => void mutate(model.downloaded ? 'delete' : 'download', model)} style={{ color: theme.text, background: theme.panelAlt, border: `1px solid ${theme.border}`, borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>{t(model.downloaded ? '删除' : '下载')}</button>
    </div>)}
  </section>;
}
