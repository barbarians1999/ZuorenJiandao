import { useT } from '../i18n/locale';
import type { ProjectSaveStatus } from '../editor/projectAutosaveQueue';

export interface ProjectSaveIndicatorProps {
  saveStatus?: ProjectSaveStatus;
  saveError?: string;
  onRetrySave?: () => Promise<boolean>;
}

export function ProjectSaveIndicator({ saveStatus = 'saved', saveError, onRetrySave }: ProjectSaveIndicatorProps) {
  const t = useT();
  const label = t(saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存失败' : '已保存');
  return <span className={`cc-save-feedback cc-save-feedback--${saveStatus}`}>
    <span className="cc-save-status" role="status" aria-live="polite" aria-busy={saveStatus === 'saving'}
      title={saveStatus === 'error' ? `${t('内容仍保留在当前窗口，保存成功前请勿关闭。')}${saveError ? `\n${saveError}` : ''}` : label}>
      <span aria-hidden="true">{saveStatus === 'saving' ? '◌' : '●'}</span> {label}
    </span>
    {saveStatus === 'error' && onRetrySave && <button type="button" className="cc-save-retry"
      onClick={() => { void onRetrySave(); }}>{t('重试保存')}</button>}
  </span>;
}
