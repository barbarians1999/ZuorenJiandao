import { captionStyleFor, type CaptionStyle } from './styles';
import { captionTemplatePatch } from './captionTemplatePatch';
import type { CaptionsData } from './types';

export const BASIC_CAPTION_STYLE: CaptionStyle = {
  ...captionStyleFor('plain'),
  labelZh: '白字黑边', hint: '整句显示，直接出现和消失',
  fontFamily: 'Noto Sans SC', fontSize: .04, fontWeight: 700,
  color: '#ffffff', highlightColor: '#ffffff', strokeColor: '#000000', strokeWidth: 4,
  textShadow: 'none', wholeLine: true, background: 'transparent',
};

export function basicCaptionPatch(captions: CaptionsData): Partial<CaptionsData> {
  const { id, label: _label, labelZh: _zh, hint: _hint, ...style } = BASIC_CAPTION_STYLE;
  return {
    ...captionTemplatePatch(captions, id, style),
    pacing: 'phrase', motionPreset: 'none',
  };
}
