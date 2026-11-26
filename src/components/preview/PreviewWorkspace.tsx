import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { InspectorPanel } from '../InspectorPanel';
import { PreviewPanel } from '../PreviewPanel';
import { TextWorkspace } from '../../library/TextWorkspace';
import type { InspectorTab } from '../inspector/InspectorContent';
import type { CompositionMosaic } from '../../editor/compositionMosaic';
import type { ClipEffect, ClipMask } from '../../editor/types';
import { isBackgroundFillActive } from '../../editor/backgroundFill';
import { listClipMosaics } from '../../editor/mosaic';
import { useT } from '../../i18n/locale';

/** Inspector tab is temporary UI state, never project data or undo history. */
export function PreviewWorkspace({ preview, inspector, text, textVisible, onRightModeChange, mosaicFocusRequest }: {
  preview: ComponentProps<typeof PreviewPanel>;
  inspector: ComponentProps<typeof InspectorPanel> | null;
  text: ComponentProps<typeof TextWorkspace>;
  textVisible: boolean;
  onRightModeChange?: (mode: 'text' | 'inspector') => void;
  mosaicFocusRequest?: { itemId: string; effectId: string; nonce: number } | null;
}) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<InspectorTab>('basic');
  const [selectedMosaicEffectId, setSelectedMosaicEffectId] = useState<string | null>(null);
  const lastMosaicNonceRef = useRef<number | null>(null);
  const [textOpened, setTextOpened] = useState(textVisible);
  if (textVisible && !textOpened) setTextOpened(true);
  const selectedItemId = inspector?.selectedItem?.id ?? null;
  useEffect(() => {
    if (!mosaicFocusRequest || mosaicFocusRequest.nonce === lastMosaicNonceRef.current) return;
    if (selectedItemId !== mosaicFocusRequest.itemId) return;
    lastMosaicNonceRef.current = mosaicFocusRequest.nonce;
    setActiveTab('effects');
    setSelectedMosaicEffectId(mosaicFocusRequest.effectId);
  }, [mosaicFocusRequest, selectedItemId]);
  const isMosaicItem = inspector?.selectedItem?.kind === 'mosaic';
  const clipMosaics = inspector?.selectedItem && !isMosaicItem ? listClipMosaics(inspector.selectedItem) : [];
  const effectiveMosaicEffectId = clipMosaics.some((entry) => entry.id === selectedMosaicEffectId)
    ? selectedMosaicEffectId
    : (clipMosaics.find((entry) => entry.mode === 'local')?.id ?? clipMosaics[0]?.id ?? null);
  const hasLocalClipMosaic = clipMosaics.some((entry) => entry.mode === 'local');
  const latestRef = useRef({ preview, inspector, textVisible });
  latestRef.current = { preview, inspector, textVisible };
  const handleSetItemMask = useCallback((id: string, mask: ClipMask | null) => {
    const { preview: p, inspector: insp } = latestRef.current;
    if (p.onSetItemMask) p.onSetItemMask(id, mask);
    else if (insp?.selectedItems.length === 1 && insp.selectedItem?.id === id) insp.onItemMaskChange(mask);
  }, []);
  const handleSetItemEffects = useCallback((id: string, effects: ClipEffect[]) => {
    const { inspector: insp, textVisible: tv } = latestRef.current;
    if (!tv && insp?.selectedItems.length === 1 && insp.selectedItem?.id === id) insp.onItemEffectsChange(effects);
  }, []);
  const handleSetCompositionMosaic = useCallback((id: string, patch: Partial<CompositionMosaic>) => {
    const { preview: p, inspector: insp } = latestRef.current;
    if (p.onSetCompositionMosaic) p.onSetCompositionMosaic(id, patch);
    else if (insp?.selectedItems.length === 1 && insp.selectedItem?.id === id) insp.onCompositionMosaicChange?.(patch);
  }, []);
  const maskEditing = !textVisible && !!inspector && !inspector.collapsed && !inspector.selectedCaption && !isMosaicItem && activeTab === 'mask';
  const mosaicEditing = !textVisible && !!inspector && !inspector.collapsed && !inspector.selectedCaption && !isMosaicItem && activeTab === 'effects' && hasLocalClipMosaic;
  const showRightShell = textVisible || !!inspector;
  return <div className="cc-preview-workspace">
    <PreviewPanel {...preview}
      maskEditing={maskEditing}
      mosaicEditing={mosaicEditing}
      selectedMosaicEffectId={effectiveMosaicEffectId}
      onSelectMosaicEffect={setSelectedMosaicEffectId}
      onSetItemMask={handleSetItemMask}
      onSetItemEffects={handleSetItemEffects}
      onSetCompositionMosaic={handleSetCompositionMosaic}
    />
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
          collapsed={Boolean(inspector.collapsed || textVisible)}
          fit={inspector.selectedItem && isBackgroundFillActive(preview.state, inspector.selectedItem) ? 'contain' : preview.state.fit}
          activeTab={activeTab}
          onActiveTabChange={setActiveTab}
          selectedMosaicEffectId={effectiveMosaicEffectId}
          onSelectMosaicEffect={setSelectedMosaicEffectId}
        />
      </div>}
      {(textVisible || textOpened) && <div className="cc-text-workspace-host" style={{ display: textVisible ? 'flex' : 'none' }}>
        <TextWorkspace {...text} visible={textVisible} />
      </div>}
    </div>}
  </div>;
}
