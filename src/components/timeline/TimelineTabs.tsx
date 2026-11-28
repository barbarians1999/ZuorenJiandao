import { useEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import { ratioLabel, type ProjectDoc } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { Icon } from '../icons';
import { sequenceReferencesTo } from '../../editor/sequenceGraph';
import { showAppToast } from '../../ui/appToast';
import { hasSharedNestedDrafts, timelineNavigationPath } from '../../editor/timelineNavigation';

interface TimelineTabsProps {
  doc: ProjectDoc;
  commands: EditorCommands;
}

/** Bottom sequence-tab bar: switch / add / rename /
 * duplicate / delete timelines, plus a one-click 9:16 vertical copy for
 * long→short retargeting. */
export function TimelineTabs({ doc, commands }: TimelineTabsProps) {
  const t = useT();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const renameFinished = useRef(false);
  const navigationRef = useRef<string[]>([]);
  const path = timelineNavigationPath(doc, navigationRef.current);
  useEffect(() => { navigationRef.current = path; });
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);

  const timelines = doc.timelines.filter((t) => !t.hidden).sort((a, b) => a.order - b.order);
  const parent = doc.timelines.find((timeline) => timeline.id === path.at(-2));
  const current = timelines.find((timeline) => timeline.id === doc.activeTimelineId);
  const nestedCopiesStayShared = hasSharedNestedDrafts(doc, doc.activeTimelineId);
  const canDelete = timelines.length > 1 && !sequenceReferencesTo(doc, doc.activeTimelineId).length;
  const deleteCurrent = () => {
    if (!current || timelines.length <= 1) return;
    if (sequenceReferencesTo(doc, current.id).length) {
      showAppToast(t('这个子草稿还在时间线中使用，请先删除引用片段。'), { error: true });
      return;
    }
    if (window.confirm(t('删除草稿「{name}」及其中的剪辑？可撤销，不会删除原素材。', { name: current.name }))) commands.deleteTimeline(current.id);
  };
  const commitRename = () => {
    if (!renameFinished.current && renaming && draft.trim()) commands.renameTimeline(renaming, draft.trim());
    renameFinished.current = true;
    setRenaming(null);
  };
  const beginRename = (id: string, name: string) => {
    renameFinished.current = false;
    setRenaming(id);
    setDraft(name);
  };


  return (
    <div className="cc-timeline-tabs" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderTop: `0.5px solid ${theme.border}`, background: theme.panel, overflowX: 'auto', flexShrink: 0 }}>
      {parent && <button type="button" style={{ ...tabBtn, background: themeAlpha.accent(0.16), border: `0.5px solid ${theme.accent}`, color: theme.text, fontWeight: 600 }} title={t('返回进入这个复合片段的上层时间线')} onClick={() => commands.switchTimeline(parent.id)}>{t('← 返回上层：{name}', { name: parent.name })}</button>}
      {timelines.map((tl) => {
        const active = tl.id === doc.activeTimelineId;
        return (
          <div
            key={tl.id}
            onClick={() => !active && commands.switchTimeline(tl.id)}
            onDoubleClick={() => beginRename(tl.id, tl.name)}
            title={t('单击切换 · 双击重命名')}
            role="button" tabIndex={0} aria-pressed={active}
            onKeyDown={(event) => { if (renaming) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); commands.switchTimeline(tl.id); } if (event.key === 'F2') { event.preventDefault(); beginRename(tl.id, tl.name); } }}
            style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 4, cursor: 'pointer', flexShrink: 0,
              background: active ? themeAlpha.accent(0.14) : 'transparent',
              border: `0.5px solid ${active ? theme.accent : theme.border}`,
              color: active ? theme.text : theme.textDim,
            }}
          >
            {renaming === tl.id ? (
              <input
                ref={inputRef}
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                  if (e.key === 'Escape') { e.preventDefault(); renameFinished.current = true; setRenaming(null); }
                }}
                style={{ width: 130, background: theme.bg, color: theme.text, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4, padding: '3px 6px', fontSize: 14, fontFamily: 'inherit' }}
              />
            ) : (
              <span style={{ fontSize: 14, whiteSpace: 'nowrap' }}>{tl.name}</span>
            )}
            <span style={{ fontSize: 13, color: theme.textDim, fontVariantNumeric: 'tabular-nums', background: theme.bg, borderRadius: 4, padding: '0 4px' }}>{ratioLabel(tl.width, tl.height)}</span>
          </div>
        );
      })}
      <span style={{ width: 6 }} />
      <button onClick={() => commands.createTimeline({ name: t('草稿 {n}', { n: doc.timelines.length + 1 }) })} title={t('新建空白草稿；不会自动放入其他时间线')} style={tabBtn}>{t('＋空白草稿')}</button>
      <button onClick={() => commands.duplicateTimeline(doc.activeTimelineId)} title={nestedCopiesStayShared ? t('复制当前草稿的剪辑；内嵌子草稿仍共用，修改内嵌内容会同步到其他引用') : t('创建可单独编辑的当前草稿副本，不复制原素材文件')} style={{ ...tabBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="copy" size={16} />{t('复制当前草稿')}</button>
      <button
        onClick={() => commands.duplicateTimeline(doc.activeTimelineId, { retarget: { width: 1080, height: 1920, fit: 'cover' }, name: '竖屏' })}
        title={t('复制当前草稿为 9:16；内嵌子草稿仍共用，不修改原草稿画幅')}
        style={{ ...tabBtn, display: 'inline-flex', alignItems: 'center', gap: 4 }}
      ><Icon name="swap" size={13} />{t('竖屏副本')}</button>
      <button type="button" style={tabBtn} disabled={!canDelete} title={canDelete ? t('删除当前草稿，不删除原素材；可撤销') : t('至少保留一个草稿，且被引用的子草稿不能删除')} onClick={deleteCurrent}>{t('删除草稿')}</button>
      {nestedCopiesStayShared && <span style={{ fontSize: 13, color: theme.textDim, whiteSpace: 'nowrap' }}>{t('复制草稿时，内嵌子草稿继续共用')}</span>}
    </div>
  );
}

const tabBtn: React.CSSProperties = {
  background: 'none', border: `0.5px solid ${theme.border}`, color: theme.textDim, cursor: 'pointer',
      fontSize: 14, borderRadius: 4, padding: '4px 8px', whiteSpace: 'nowrap', flexShrink: 0,
};
