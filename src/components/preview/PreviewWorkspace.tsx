import { useState, type ComponentProps } from 'react';
import { InspectorPanel } from '../InspectorPanel';
import { PreviewPanel } from '../PreviewPanel';
import { TextWorkspace } from '../../library/TextWorkspace';
import type { InspectorTab } from '../inspector/InspectorContent';
import { isBackgroundFillActive } from '../../editor/backgroundFill';
import { useT } from '../../i18n/locale';

/** Inspector tab is temporary UI state, never project data or undo history. */
export function PreviewWorkspace({ preview, inspector, text, textVisible, onRightModeChange }: {
  preview: ComponentProps<typeof PreviewPanel>;
  inspector: ComponentProps<typeof InspectorPanel> | null;
  text: ComponentProps<typeof TextWorkspace>;
  textVisible: boolean;
  onRightModeChange?: (mode: 'text' | 'inspector') => void;
}) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<InspectorTab>('basic');
  const [textOpened, setTextOpened] = useState(textVisible);
  if (textVisible && !textOpened) setTextOpened(true);
  const isMosaicItem = inspector?.selectedItem?.kind === 'mosaic';
  const maskEditing = !textVisible && !!inspector && !inspector.collapsed && !inspector.selectedCaption && !isMosaicItem && activeTab === 'mask';
  const mosaicEditing = !textVisible && !!inspector && !inspector.collapsed && !inspector.selectedCaption && !isMosaicItem && activeTab === 'mosaic';
  const showRightShell = textVisible || !!inspector;
  return <div className="cc-preview-workspace">
    <PreviewPanel {...preview} maskEditing={maskEditing} mosaicEditing={mosaicEditing} onSetItemMask={(id, mask) => {
      if (preview.onSetItemMask) preview.onSetItemMask(id, mask);
      else if (inspector?.selectedItems.length === 1 && inspector.selectedItem?.id === id) inspector.onItemMaskChange(mask);
    }} onSetItemEffects={(id, effects) => {
      if (!textVisible && inspector?.selectedItems.length === 1 && inspector.selectedItem?.id === id) inspector.onItemEffectsChange(effects);
    }} onSetCompositionMosaic={(id, patch) => {
      if (preview.onSetCompositionMosaic) preview.onSetCompositionMosaic(id, patch);
      else if (inspector?.selectedItems.length === 1 && inspector.selectedItem?.id === id) inspector.onCompositionMosaicChange?.(patch);
    }} />
    {showRightShell && <div className="cc-right-panel-shell">
      {(textVisible || !!inspector?.selectedCaption || !inspector?.selectedItem) && (
        <div className="cc-right-panel-tabs" role="tablist" aria-label={t('右侧面板')}>
          <button type="button" role="tab" aria-selected={textVisible} onClick={() => onRightModeChange?.('text')}>
            {t('字幕列表')}
          </button>
          {inspector && <button type="button" role="tab" aria-selected={!textVisible} onClick={() => onRightModeChange?.('inspector')}>
            {inspector.selectedCaption ? t('属性（大小·描边）') : t('属性')}
          </button>}
        </div>
      )}
      {inspector && <div className="cc-inspector-host" style={{ display: textVisible ? 'none' : 'flex' }}>
        <InspectorPanel {...inspector}
          fit={inspector.selectedItem && isBackgroundFillActive(preview.state, inspector.selectedItem) ? 'contain' : preview.state.fit}
          activeTab={activeTab} onActiveTabChange={setActiveTab} />
      </div>}
      {(textVisible || textOpened) && <div className="cc-text-workspace-host" style={{ display: textVisible ? 'flex' : 'none' }}>
        <TextWorkspace {...text} />
      </div>}
    </div>}
  </div>;
}
