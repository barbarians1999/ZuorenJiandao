import { TRANSITION_LABELS, ZOOM_SHAPE_LABELS, type TimelineItem, type TransitionItem } from '../../editor/types';
import { ALL_FX, FX_EFFECTS, LUT_EFFECTS } from '../../gl/fx/effects';
import { useT } from '../../i18n/locale';

/** corner chips so applied fx / lut / zoom / denoise / transition are visible on the clip */
export function ClipEffectBadges({
  item,
  inTransition,
}: {
  item: TimelineItem;
  inTransition: TransitionItem | null;
}) {
  const t = useT();
  const chips: { key: string; label: string; title: string; className: string }[] = [];
  const effects = item.effects ?? [];
  const fxNames = effects
    .filter((e) => e.assetId in FX_EFFECTS)
    .map((e) => t(FX_EFFECTS[e.assetId]?.name ?? e.assetId));
  const lutNames = effects
    .filter((e) => e.assetId in LUT_EFFECTS)
    .map((e) => t(LUT_EFFECTS[e.assetId]?.name ?? e.assetId));
  // custom / uncategorized shaders
  const otherFx = effects.filter((e) => !(e.assetId in FX_EFFECTS) && !(e.assetId in LUT_EFFECTS));

  if (fxNames.length || otherFx.length) {
    const n = fxNames.length + otherFx.length;
    chips.push({
      key: 'fx',
      label: n > 1 ? t('特效×{n}', { n }) : (fxNames[0] ?? t(ALL_FX[otherFx[0]?.assetId]?.name ?? '特效')),
      title: [...fxNames, ...otherFx.map((e) => t(ALL_FX[e.assetId]?.name ?? e.assetId))].join(' · '),
      className: 'fx',
    });
  }
  if (lutNames.length) {
    chips.push({
      key: 'lut',
      label: lutNames.length > 1 ? `LUT×${lutNames.length}` : lutNames[0],
      title: lutNames.join(' · '),
      className: 'lut',
    });
  }
  if (item.zoom?.shape || item.zoom?.envelope || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0) {
    const shape = item.zoom?.shape;
    // The plugin envelope curve has no shape, use the built-in label (plugin data, not entered into the dictionary)
    const name = shape ? t(ZOOM_SHAPE_LABELS[shape] ?? shape) : item.zoom?.label;
    chips.push({
      key: 'zoom',
      label: name ?? t('缩放'),
      title: name ? t('缩放 · {name}', { name }) : t('关键帧缩放'),
      className: 'zoom',
    });
  }
  if (item.denoisedSrc) {
    chips.push({ key: 'iso', label: t('人声'), title: t('已应用人声隔离'), className: 'iso' });
  }
  if (inTransition) {
    const trName = t(TRANSITION_LABELS[inTransition.type] ?? inTransition.type);
    chips.push({ key: 'tr', label: trName, title: t('入场转场 · {name}', { name: trName }), className: 'tr' });
  }
  if (!chips.length) return null;
  return (
    <div className="cc-clip-badges" aria-hidden>
      {chips.map((c) => (
        <span key={c.key} className={`cc-clip-badge ${c.className}`} title={c.title}>{c.label}</span>
      ))}
    </div>
  );
}
