import { Icon, type IconName } from '../components/icons';
import { useT } from '../i18n/locale';

export const RESOURCE_TOOLS = ['音效'] as const;
export type ResourceTool = typeof RESOURCE_TOOLS[number];
export type LibraryTool = ResourceTool | '我的素材' | '特效' | '字幕' | '序列' | '扩展中心';
export const LIBRARY_TOOLS: readonly { id: LibraryTool; label: string; icon: IconName }[] = [
  { id: '我的素材', label: '我的素材', icon: 'folder' },
  { id: '特效', label: '特效', icon: 'sparkles' },
  { id: '字幕', label: '字幕与文字', icon: 'captions' },
  { id: '音效', label: '音效', icon: 'volume' },
  { id: '序列', label: '子草稿', icon: 'film' },
  { id: '扩展中心', label: '扩展中心', icon: 'grid' },
];
export function isResourceTool(tool: LibraryTool): tool is ResourceTool {
  return RESOURCE_TOOLS.some((resource) => resource === tool);
}
export function LibraryNavigation({ active, onSelect }: { active: LibraryTool; onSelect: (tool: LibraryTool) => void }) {
  const t = useT();
  return <nav className="cc-library-rail" aria-label={t('资源库')}>
    {LIBRARY_TOOLS.map(({ id, label, icon }) => <button key={id} type="button"
      aria-pressed={active === id} title={t(label)} className={`cc-library-tool${active === id ? ' selected' : ''}`}
      onClick={() => onSelect(id)}>
      <Icon name={icon} size={18} /><span>{t(label)}</span>
    </button>)}
  </nav>;
}
