import type { Tpl } from '../types';

const designs = [
  { id: 'editorial', name: '章节 · 留白横线', background: '#f4f1e9', ink: '#191919', accent: '#ba3b31' },
  { id: 'index', name: '章节 · 黑底序号', background: '#000000', ink: '#f6f1e5', accent: '#e9bd53' },
  { id: 'split', name: '章节 · 色块分栏', background: '#f5efe1', ink: '#181818', accent: '#dfb650' },
  { id: 'poster', name: '章节 · 构成海报', background: '#f2e8cc', ink: '#101010', accent: '#c43128' },
] as const;

// Pure local drawing; the editable text and timing travel with the project.
// Same component runs in Player, WebCodecs and the compatible renderer.
function chapterCode(design: string): string {
  return `const ChapterCard = ({item}) => {
    const p = item.props;
    const f = useCurrentFrame() + (item.frameOffset || 0);
    const w = item.width, h = item.height, portrait = h > w;
    const unit = Math.min(w, h) / 1080;
    const clamp = (x) => Math.max(0, Math.min(1, x));
    const span = Math.max(0, (item.durationInFrames || 150) - 1);
    const a = Math.max(1, Math.min(300, Number(p.entranceFrames) || 18));
    const b = Math.max(1, Math.min(300, Number(p.exitFrames) || 12));
    const factor = a + b > span ? span / (a + b) : 1;
    const enter = span >= 2 ? clamp(f / (a * factor)) : 1;
    const exit = span >= 2 ? clamp((span - f) / (b * factor)) : 1;
    const ease = 1 - Math.pow(1 - enter, 3);
    const bg = p.background, ink = p.ink, accent = p.accent;
    const title = String(p.title || ''), number = String(p.number || '01');
    const design = ${JSON.stringify(design)};
    const pad = 100 * unit;
    const font = (portrait ? 94 : 112) * unit * Math.min(1, Math.sqrt((portrait ? 16 : 30) / Math.max(1, Array.from(title).length)));
    const titleStyle = {fontSize:font, fontWeight:800, lineHeight:1.2, whiteSpace:'pre-wrap', overflowWrap:'anywhere', margin:0};
    const small = {fontSize:28*unit, letterSpacing:3*unit, lineHeight:1.5};
    const content = {position:'absolute', inset:pad, display:'flex', flexDirection:'column', justifyContent:'center', gap:32*unit, opacity:enter*exit, transform:'translateY(' + ((1-ease)*38+(1-exit)*-24)*unit + 'px)'};
    return <AbsoluteFill style={{background:bg, color:ink, fontFamily:p.fontFamily || 'Noto Sans SC', overflow:'hidden'}}>
      {design === 'editorial' && <div style={content}>
        <div style={{...small, color:accent}}>{String(p.kicker)} / {number}</div>
        <div style={{height:4*unit, width:(portrait?160:240)*unit, background:accent, transform:'scaleX('+ease+')', transformOrigin:'left'}} />
        <h1 style={{...titleStyle, maxWidth:portrait?'100%':'85%'}}>{title}</h1>
        <div style={{...small, opacity:0.7, maxWidth:'90%', overflowWrap:'anywhere'}}>{String(p.subtitle)}</div>
      </div>}
      {design === 'index' && <>
        <div style={{position:'absolute', right:pad*0.5, bottom:pad*0.25, fontSize:(portrait?480:680)*unit, fontWeight:900, lineHeight:1, color:accent, opacity:0.12*enter*exit}}>{number}</div>
        <div style={{...content, textAlign:'center', alignItems:'center'}}>
          <div style={{...small, color:accent}}>{String(p.kicker)} {number}</div>
          <h1 style={{...titleStyle, maxWidth:'95%', clipPath:'inset(0 '+(1-ease)*100+'% 0 0)'}}>{title}</h1>
          <div style={{height:2*unit, width:120*unit, background:accent}} />
          <div style={{...small, opacity:0.75, overflowWrap:'anywhere', maxWidth:'95%'}}>{String(p.subtitle)}</div>
        </div>
      </>}
      {design === 'split' && <>
        <div style={{position:'absolute', top:0, left:0, width:portrait?'100%':'28%', height:portrait?'26%':'100%', background:accent, transform:portrait?'translateY('+((1-ease)*-100)+'%)':'translateX('+((1-ease)*-100)+'%)'}} />
        <div style={{...content, inset:undefined, left:portrait?pad:w*0.34, right:pad, top:portrait?h*0.33:pad, bottom:pad}}>
          <div style={small}>{String(p.kicker)}</div><h1 style={titleStyle}>{title}</h1>
          <div style={{...small, opacity:0.7, overflowWrap:'anywhere'}}>{String(p.subtitle)}</div>
        </div>
        <div style={{position:'absolute', left:portrait?pad:w*0.05, top:portrait?h*0.05:h*0.36, fontSize:(portrait?200:220)*unit, fontWeight:900, color:ink, opacity:enter*exit}}>{number}</div>
      </>}
      {design === 'poster' && <>
        <svg width={w} height={h} style={{position:'absolute', opacity:enter*exit}}><polygon points={portrait ? '0,0 '+w+',0 0,'+h*0.28 : '0,0 '+w*0.44+',0 0,'+h*0.72} fill={accent} /><rect x={w*0.88} y={h*0.68} width={w*0.045} height={h*0.24} fill={ink} /></svg>
        <div style={{position:'absolute', top:pad*0.6, left:pad, color:bg, fontSize:120*unit, fontWeight:900, opacity:enter*exit}}>{number}</div>
        <div style={{...content, top:portrait?h*0.32:h*0.34, right:pad*1.8}}>
          <div style={{...small, fontWeight:700}}>{String(p.kicker)}</div>
          <h1 style={{...titleStyle, transform:'translateX('+((1-ease)*60)*unit+'px)'}}>{title}</h1>
          <div style={{width:180*unit, height:12*unit, background:accent}} />
          <div style={{...small, opacity:0.75, overflowWrap:'anywhere'}}>{String(p.subtitle)}</div>
        </div>
      </>}
    </AbsoluteFill>;
  };`;
}

function thumbnail(design: typeof designs[number], portrait: boolean): string {
  const w = portrait ? 270 : 480, h = portrait ? 480 : 270;
  const decoration = design.id === 'poster' ? `<path d="M0 0H${w * .5}L0 ${h * .45}Z" fill="${design.accent}"/>`
    : design.id === 'split' ? `<rect width="${portrait ? w : w * .28}" height="${portrait ? h * .24 : h}" fill="${design.accent}"/>`
    : `<rect x="28" y="${h * .35}" width="65" height="3" fill="${design.accent}"/>`;
  const x = design.id === 'split' && !portrait ? 160 : 28;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${design.background}"/>${decoration}<g fill="${design.ink}" font-family="Microsoft YaHei,sans-serif"><text x="${x}" y="${h * .47}" font-size="12">CHAPTER / 01</text><text x="${x}" y="${h * .61}" font-size="${portrait ? 25 : 30}" font-weight="800">故事的转折</text><text x="${x}" y="${h * .73}" font-size="12">从这里，进入下一章</text></g></svg>`);
}

export const CHAPTER_TEMPLATES: Tpl[] = designs.flatMap((design) => [false, true].map((portrait) => ({
  id: `zuoren-chapter-${design.id}-${portrait ? 'portrait' : 'landscape'}`,
  name: `${design.name}（${portrait ? '竖屏' : '横屏'}）`,
  category: 'chapter-cards', description: '本地章节标题卡：可编辑文字、配色和入出时长；声音不变。', tags: ['章节', '标题', '本地'],
  width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, fps: 30, durationInFrames: 150,
  props: { number: '01', kicker: 'CHAPTER', title: '故事的转折', subtitle: '从这里，进入下一章', fontFamily: 'Noto Sans SC', background: design.background, ink: design.ink, accent: design.accent, entranceFrames: 18, exitFrames: 12 },
  propSchema: [
    { key: 'number', type: 'string', label: '章节序号', defaultValue: '01' },
    { key: 'kicker', type: 'string', label: '章节标签', defaultValue: 'CHAPTER' },
    { key: 'title', type: 'text', label: '章节标题', defaultValue: '故事的转折' },
    { key: 'subtitle', type: 'text', label: '副标题', defaultValue: '从这里，进入下一章' },
    { key: 'background', type: 'color', label: '背景色', defaultValue: design.background },
    { key: 'ink', type: 'color', label: '文字颜色', defaultValue: design.ink },
    { key: 'accent', type: 'color', label: '点缀色', defaultValue: design.accent },
    { key: 'entranceFrames', type: 'number', label: '入场帧数', defaultValue: 18, min: 1, max: 300, step: 1 },
    { key: 'exitFrames', type: 'number', label: '出场帧数', defaultValue: 12, min: 1, max: 300, step: 1 },
  ], thumb: thumbnail(design, portrait), code: chapterCode(design.id),
})));
