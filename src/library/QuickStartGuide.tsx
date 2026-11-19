import { PROJECT_QUICK_STARTS, type ProjectQuickStart } from '../app/projectQuickStart';
import { useT } from '../i18n/locale';

export function QuickStartGuide({ intent, onImport, onPaste, onDismiss }: {
  intent: ProjectQuickStart;
  onImport: () => void;
  onPaste: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const entry = PROJECT_QUICK_STARTS.find((candidate) => candidate.intent === intent)!;
  const hint = intent === 'captions'
    ? '先导入口播素材并加入时间线，完成本机转写后再粘贴文字稿。识别模型未安装时可在设置中下载。'
    : '导入素材并拖入时间线，然后分割、裁切或移动片段。';
  return <section className="cc-quick-start-guide" aria-label={t(entry.title)}>
    <div><strong>{t(entry.title)}</strong><button type="button" onClick={onDismiss} aria-label={t('关闭操作提示')}>{t('收起提示')}</button></div>
    <p>{t(hint)}</p>
    <div className="cc-quick-start-guide-actions">
      <button type="button" onClick={onImport}>{t(intent === 'captions' ? '导入口播素材' : '导入素材')}</button>
      {intent === 'captions' && <button type="button" onClick={onPaste}>{t('粘贴文字稿')}</button>}
    </div>
  </section>;
}
