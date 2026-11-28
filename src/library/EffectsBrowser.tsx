import { useMemo, useState, type ReactNode } from 'react';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';
import {
  ZOOM_SHAPE_LABELS,
  ZOOM_SHAPE_ORDER,
  type TimelineItem,
  type ZoomEffect,
  type ZoomShape,
} from '../editor/types';
import { TRANSITION_LABELS, TRANSITION_ORDER, type TransitionType } from '../editor/transitionTypes';
import { FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import { customTransitionUniforms, getCustomTransition } from '../gl/customTransitions';
import { PAPER_BACKGROUND_PRESETS } from '../editor/paperBackgrounds';
import { VECTOR_SHAPE_DEFAULTS } from '../editor/vectorShapes';
import { EXPLAINER_TEMPLATES } from './explainerTemplates';
import type { Tpl } from '../types';
import { setLibraryDrag } from './drag';
import { FxThumb } from './FxThumb';
import { asPluginZoom, pluginResourceItems, usePluginPacks } from './pluginResources';
import { ResourceBrowser, type ResourceItem } from './ResourceBrowser';
import { TransitionThumb } from './TransitionThumb';
import { ZoomThumb } from './ZoomThumb';

export type EffectsSubTab = 'fx' | 'lut' | 'transition' | 'zoom' | 'shapes' | 'explainer';

export interface EffectsBrowserProps {
  selectedItem?: TimelineItem | null;
  defaultSubTab?: EffectsSubTab;
  templates?: Tpl[];
  onAddTemplate?: (tpl: Tpl) => void;
  onAddSolid?: (preset?: { name?: string; color?: string; props?: Record<string, unknown> }) => void;
  onAddShape?: (shape: 'rectangle' | 'ellipse') => void;
  onAddMosaic?: () => void;
  onApplyFx?: (assetId: string) => void;
  onApplyTransition?: (type: TransitionType, custom?: { frag: string; uniforms: Record<string, number>; label: string }) => void;
  onApplyZoom?: (zoom: ZoomEffect) => void;
}

interface EffectCardSpec {
  id: string;
  label: string;
  hint: string;
  preview: ReactNode;
  onClick?: () => void;
}

const SUB_TABS: ReadonlyArray<{ id: EffectsSubTab; label: string }> = [
  { id: 'shapes', label: '形状与马赛克' },
  { id: 'explainer', label: '科普组件' },
  { id: 'fx', label: '画面特效' },
  { id: 'lut', label: '滤镜 LUT' },
  { id: 'transition', label: '转场' },
  { id: 'zoom', label: '推拉缩放' },
];

export function EffectsBrowser({
  selectedItem = null,
  defaultSubTab = 'shapes',
  templates,
  onAddTemplate,
  onAddSolid,
  onAddShape,
  onAddMosaic,
  onApplyFx,
  onApplyTransition,
  onApplyZoom,
}: EffectsBrowserProps) {
  const t = useT();
  const [subTab, setSubTab] = useState<EffectsSubTab>(defaultSubTab);
  const packs = usePluginPacks();

  const fxItems = useMemo<ResourceItem[]>(() => [
    ...FX_IDS.map((id) => ({ id, name: FX_EFFECTS[id]!.name })),
    ...pluginResourceItems(packs, 'fx'),
  ], [packs]);

  const lutItems = useMemo<ResourceItem[]>(() => [
    ...LUT_IDS.map((id) => ({ id, name: LUT_EFFECTS[id]!.name })),
    ...pluginResourceItems(packs, 'lut'),
  ], [packs]);

  const transitionItems = useMemo<ResourceItem[]>(() => [
    ...TRANSITION_ORDER.map((id) => ({ id, name: TRANSITION_LABELS[id] })),
    ...pluginResourceItems(packs, 'transition'),
  ], [packs]);

  const zoomItems = useMemo<ResourceItem[]>(() => [
    ...ZOOM_SHAPE_ORDER.map((shape) => ({ id: shape, name: ZOOM_SHAPE_LABELS[shape] })),
    ...pluginResourceItems(packs, 'zoom'),
  ], [packs]);

  const fxById = useMemo(() => new Map(fxItems.map((item) => [item.id, item])), [fxItems]);
  const lutById = useMemo(() => new Map(lutItems.map((item) => [item.id, item])), [lutItems]);
  const zoomById = useMemo(() => new Map(zoomItems.map((item) => [item.id, item])), [zoomItems]);

  const canApplyShaderOrLut = selectedItem?.kind === 'video' || selectedItem?.kind === 'image';
  const canApplyVisualMotion = !!selectedItem && selectedItem.kind !== 'audio';

  const shapeCards: EffectCardSpec[] = [
    ...(onAddShape ? [
      {
        id: 'shape-rectangle',
        label: t('矩形'),
        hint: t('可调描边与填充'),
        onClick: () => onAddShape('rectangle'),
        preview: (
          <div style={{
            width: 52,
            height: 34,
            borderRadius: 6,
            border: `2px solid ${theme.accent}`,
            background: themeAlpha.accent(0.16),
          }} />
        ),
      },
      {
        id: 'shape-ellipse',
        label: t('椭圆'),
        hint: t('圆形与椭圆标注'),
        onClick: () => onAddShape('ellipse'),
        preview: (
          <div style={{
            width: 52,
            height: 34,
            borderRadius: '50%',
            border: `2px solid ${theme.accent}`,
            background: themeAlpha.accent(0.16),
          }} />
        ),
      },
    ] : []),
    ...(onAddSolid ? [
      {
        id: 'vector-line',
        label: t('精细直线'),
        hint: t('1–20px 矢量分割线/装饰线'),
        onClick: () => onAddSolid({ name: '精细直线', color: '#d4af37', props: { shapeKind: 'line', ...VECTOR_SHAPE_DEFAULTS.line } }),
        preview: (
          <svg width={52} height={34} viewBox="0 0 52 34">
            <line x1={6} y1={17} x2={46} y2={17} stroke={theme.accent} strokeWidth={2.5} strokeLinecap="round" />
          </svg>
        ),
      },
      {
        id: 'vector-rect',
        label: t('矩形边框'),
        hint: t('轻量空心框与圆角线框'),
        onClick: () => onAddSolid({ name: '矩形边框', color: '#d4af37', props: { shapeKind: 'rect', ...VECTOR_SHAPE_DEFAULTS.rect } }),
        preview: (
          <svg width={52} height={34} viewBox="0 0 52 34">
            <rect x={8} y={6} width={36} height={22} rx={4} fill="none" stroke={theme.accent} strokeWidth={2} />
          </svg>
        ),
      },
      {
        id: 'vector-arrow',
        label: t('指向箭头'),
        hint: t('单向/双向矢量指示箭头'),
        onClick: () => onAddSolid({ name: '指向箭头', color: '#d4af37', props: { shapeKind: 'arrow', ...VECTOR_SHAPE_DEFAULTS.arrow } }),
        preview: (
          <svg width={52} height={34} viewBox="0 0 52 34">
            <line x1={8} y1={17} x2={38} y2={17} stroke={theme.accent} strokeWidth={2.5} strokeLinecap="round" />
            <polygon points="36,11 46,17 36,23" fill={theme.accent} />
          </svg>
        ),
      },
      {
        id: 'solid-bg',
        label: t('纯色背景'),
        hint: t('可调纯色底层/遮罩'),
        onClick: () => onAddSolid(),
        preview: (
          <div style={{
            width: 52,
            height: 34,
            borderRadius: 6,
            border: `1px solid ${theme.borderLight}`,
            background: `linear-gradient(135deg, ${theme.panelAlt}, ${theme.hover})`,
          }} />
        ),
      },
    ] : []),
  ];

  const explainerList = useMemo(() => {
    const fromProps = (templates ?? []).filter((tpl) => tpl.category === 'explainer-kits');
    return fromProps.length ? fromProps : EXPLAINER_TEMPLATES;
  }, [templates]);

  const paperCards: EffectCardSpec[] = onAddSolid
    ? PAPER_BACKGROUND_PRESETS.map((preset) => ({
        id: `paper-${preset.id}`,
        label: t(preset.label),
        hint: t('内置纸张颗粒与中心微亮渐变的背景板'),
        onClick: () => onAddSolid({
          name: preset.label,
          color: preset.colors[1],
          props: {
            paperPreset: preset.id,
            color: preset.colors[1],
            paperGrain: preset.defaultGrain,
            paperVignette: preset.defaultVignette,
            paperAccentLine: preset.defaultAccentLine,
          },
        }),
        preview: (
          <div style={{
            width: 54,
            height: 34,
            borderRadius: 6,
            border: `1px solid ${theme.borderLight}`,
            background: `radial-gradient(circle at 50% 45%, ${preset.colors[0]}, ${preset.colors[2]})`,
          }} />
        ),
      }))
    : [];

  const blurCards: EffectCardSpec[] = [
    ...(onAddMosaic ? [{
      id: 'gaussian-mosaic',
      label: t('高斯模糊（马赛克）'),
      hint: t('局部遮挡与模糊强度可调'),
      onClick: onAddMosaic,
      preview: (
        <div style={{
          width: 54,
          height: 36,
          borderRadius: 8,
          border: `1px solid ${theme.borderLight}`,
          background: `linear-gradient(135deg, ${themeAlpha.ink(0.16)}, ${themeAlpha.ink(0.05)})`,
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gridTemplateRows: 'repeat(3, 1fr)',
          gap: 2,
          padding: 4,
          boxSizing: 'border-box',
        }}>
          {Array.from({ length: 12 }, (_, idx) => (
            <span
              key={idx}
              style={{
                borderRadius: 2,
                background: idx % 3 === 0 ? themeAlpha.accent(0.45) : themeAlpha.ink(idx % 2 === 0 ? 0.28 : 0.14),
              }}
            />
          ))}
        </div>
      ),
    }] : []),
  ];

  const applyTransition = (id: string) => {
    const custom = getCustomTransition(id);
    if (custom) {
      onApplyTransition?.('custom-shader', {
        frag: custom.frag,
        uniforms: customTransitionUniforms(custom),
        label: custom.label,
      });
      return;
    }
    onApplyTransition?.(id as TransitionType);
  };

  const applyZoom = (id: string) => {
    const entry = zoomById.get(id);
    const pluginZoom = entry?.data ? asPluginZoom(entry.data) : null;
    if (pluginZoom) {
      onApplyZoom?.(pluginZoom);
      return;
    }
    onApplyZoom?.({ shape: id as ZoomShape });
  };

  return (
    <div className="cc-effects-browser">
      <div
        className="cc-resource-tertiary-tabs"
        role="tablist"
        aria-label={t('画面包装与特效分类')}
      >
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            className={subTab === tab.id ? 'active' : undefined}
            onClick={() => setSubTab(tab.id)}
          >
            {t(tab.label)}
          </button>
        ))}
      </div>

      {subTab === 'fx' && (
        <ResourceBrowser
          hint="点选或拖放到视频/图片片段"
          items={fxItems}
          applicable={canApplyShaderOrLut && !!onApplyFx}
          dragKind="fx"
          layout="grid"
          onApply={(id) => onApplyFx?.(id)}
          renderThumb={(id, playing) => {
            const thumb = fxById.get(id)?.thumb;
            return thumb
              ? <img className="cc-resource-card-img" src={thumb} alt="" draggable={false} />
              : <FxThumb assetId={id} playing={playing} />;
          }}
        />
      )}

      {subTab === 'lut' && (
        <ResourceBrowser
          hint="点选或拖放胶片调色 LUT 到视频/图片片段"
          items={lutItems}
          applicable={canApplyShaderOrLut && !!onApplyFx}
          dragKind="lut"
          layout="grid"
          onApply={(id) => onApplyFx?.(id)}
          renderThumb={(id, playing) => {
            const thumb = lutById.get(id)?.thumb;
            return thumb
              ? <img className="cc-resource-card-img" src={thumb} alt="" draggable={false} />
              : <FxThumb assetId={id} playing={playing} />;
          }}
        />
      )}

      {subTab === 'transition' && (
        <ResourceBrowser
          hint="选中同一轨道后方紧邻片段后点选，或直接拖到片段"
          items={transitionItems}
          applicable={canApplyVisualMotion && !!onApplyTransition}
          dragKind="transition"
          layout="grid"
          onApply={applyTransition}
          renderThumb={(id, playing) => <TransitionThumb type={id} playing={playing} />}
        />
      )}

      {subTab === 'zoom' && (
        <ResourceBrowser
          hint="点选或拖放推拉缩放曲线到视觉片段"
          items={zoomItems}
          applicable={canApplyVisualMotion && !!onApplyZoom}
          dragKind="zoom"
          layout="grid"
          onApply={applyZoom}
          renderThumb={(id, playing) => (
            zoomById.get(id)?.data
              ? <span className="cc-resource-thumb-placeholder" />
              : <ZoomThumb shape={id as ZoomShape} playing={playing} />
          )}
        />
      )}

      {subTab === 'shapes' && (
        <>
          <div className="cc-effects-section">
            <div className="cc-effects-section-title">{t('形状与画布')}</div>
            <div className="cc-effects-grid">
              {shapeCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="cc-effect-card"
                  draggable
                  onDragStart={(event) => setLibraryDrag(event, { kind: 'effect-tool', id: card.id, name: card.label })}
                  onClick={card.onClick}
                  title={card.hint}
                >
                  <div className="cc-effect-card-thumb">{card.preview}</div>
                  <span className="cc-effect-card-label">{card.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="cc-effects-section">
            <div className="cc-effects-section-title">{t('高斯模糊（马赛克）')}</div>
            <div className="cc-effects-grid">
              {blurCards.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="cc-effect-card"
                  draggable
                  onDragStart={(event) => setLibraryDrag(event, { kind: 'effect-tool', id: card.id, name: card.label })}
                  onClick={card.onClick}
                  title={card.hint}
                >
                  <div className="cc-effect-card-thumb">{card.preview}</div>
                  <span className="cc-effect-card-label">{card.label}</span>
                </button>
              ))}
            </div>
          </div>

          {paperCards.length > 0 && (
            <div className="cc-effects-section">
              <div className="cc-effects-section-title">{t('纸纹背景板')}</div>
              <div className="cc-effects-grid">
                {paperCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="cc-effect-card"
                    onClick={card.onClick}
                    title={card.hint}
                  >
                    <div className="cc-effect-card-thumb">{card.preview}</div>
                    <span className="cc-effect-card-label">{card.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {subTab === 'explainer' && (
        <>
          <div className="cc-effects-section">
            <div className="cc-effects-section-title">{t('科普动效组件（点一下上轨，右侧填字即可）')}</div>
            <div className="cc-effects-grid cc-effects-grid--wide">
              {explainerList.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="cc-effect-card"
                  onClick={() => onAddTemplate?.(tpl)}
                  title={tpl.description ?? tpl.name}
                >
                  <div className="cc-effect-card-thumb">
                    {tpl.thumb ? <img src={tpl.thumb} alt="" draggable={false} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
                  </div>
                  <span className="cc-effect-card-label">{t(tpl.name)}</span>
                </button>
              ))}
            </div>
          </div>

          {paperCards.length > 0 && (
            <div className="cc-effects-section">
              <div className="cc-effects-section-title">{t('配套纸纹背景板')}</div>
              <div className="cc-effects-grid">
                {paperCards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className="cc-effect-card"
                    onClick={card.onClick}
                    title={card.hint}
                  >
                    <div className="cc-effect-card-thumb">{card.preview}</div>
                    <span className="cc-effect-card-label">{card.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
