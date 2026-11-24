import { useT } from '../i18n/locale';
import { captionStyleFor } from './styles';
import type { CaptionsData } from './types';
import { FontPicker } from '../fonts/FontPicker';
import { captionFontPatch } from '../fonts/captionFontScope';

export function CaptionFontPicker({ captions, onUpdate }: {
  captions: CaptionsData; onUpdate: (patch: Partial<CaptionsData>) => void;
}) {
  const t = useT();
  const current = captions.styleOverride?.fontFamily ?? captionStyleFor(captions.template).fontFamily;
  return <div className="cc-cap-field">
    <div className="cc-cap-label">{t('字体 · 整个字幕轨道')}</div>
    <FontPicker value={current} fontAssetId={captions.styleOverride?.fontAssetId}
      onChange={(choice) => onUpdate(captionFontPatch(captions, choice, 'track'))} />
  </div>;
}
