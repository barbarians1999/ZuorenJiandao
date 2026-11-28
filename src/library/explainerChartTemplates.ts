import type { Tpl } from '../types';

function makeThumb(svgBody: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">${svgBody}</svg>`,
  )}`;
}

// 6. 条形 / 柱状统计图组件
const BAR_CHART_CODE = `const BarChartCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 180);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  const fontAliases = {
    '思源宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '衬线体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '思源黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '霞鹜文楷': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
    '楷体': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
  };
  const resolvedFont = fontAliases[String(p.fontFamily || '').trim()] || String(p.fontFamily || '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif');

  const themeKey = String(p.themePreset || 'warm-paper');
  const presets = {
    'warm-paper': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#6b5d4f',
      accent: '#a62121',
      mutedBar: '#8f8172',
      grid: 'rgba(107,93,79,0.22)',
      track: 'rgba(140,122,101,0.14)',
      border: 'rgba(140,122,101,0.38)',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.26)',
    },
    'crimson-archive': {
      cardBg: '#4b0a0e',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      mutedBar: '#a3756c',
      grid: 'rgba(244,236,218,0.18)',
      track: 'rgba(244,236,218,0.10)',
      border: 'rgba(212,175,55,0.38)',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.42)',
    },
    'transparent-light': {
      cardBg: '#1c1816',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      mutedBar: '#a3756c',
      grid: 'rgba(244,236,218,0.22)',
      track: 'rgba(244,236,218,0.10)',
      border: 'transparent',
      transparent: true,
      shadow: 'none',
    },
    'transparent-dark': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#5c4f42',
      accent: '#a62121',
      mutedBar: '#8f8172',
      grid: 'rgba(92,79,66,0.22)',
      track: 'rgba(92,79,66,0.10)',
      border: 'transparent',
      transparent: true,
      shadow: 'none',
    },
  };
  const activePreset = presets[themeKey] || presets['warm-paper'];
  const normHex = (v) => String(v || '').trim().toLowerCase();
  const pickThemeColor = (propVal, schemaDef, presetVal) => {
    if (themeKey === 'custom') return String(propVal || presetVal);
    if (!propVal || normHex(propVal) === normHex(schemaDef)) return presetVal;
    return String(propVal);
  };

  const cardBg = pickThemeColor(p.cardBgColor, '#f4ecda', activePreset.cardBg);
  const inkColor = pickThemeColor(p.inkColor, '#1c1816', activePreset.ink);
  const accentColor = pickThemeColor(p.accentColor, '#a62121', activePreset.accent);
  const mutedBarColor = pickThemeColor(p.mutedColor, '#8f8172', activePreset.mutedBar);
  const mutedInk = activePreset.mutedInk;
  const gridColor = activePreset.grid;
  const trackColor = activePreset.track;
  const bgAlpha = activePreset.transparent ? 0 : clamp01(Number(p.cardBgOpacity ?? 96) / 100);

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '').trim();
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return hex;
  };

  const defaultUnit = String(p.defaultUnit ?? '').trim();
  const highlightSet = new Set(
    String(p.highlightIndex || '')
      .split(/[,，\\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1),
  );

  const parseNumeric = (raw) => {
    const cleaned = String(raw || '').replace(/,/g, '').trim();
    const m = cleaned.match(/-?\\d+(?:\\.\\d+)?/);
    if (!m) return { num: 0, unit: '', decimals: 0 };
    const num = Number(m[0]);
    const idx = cleaned.indexOf(m[0]);
    const rest = (cleaned.slice(0, idx) + cleaned.slice(idx + m[0].length)).trim();
    const dot = m[0].indexOf('.');
    const decimals = dot >= 0 ? Math.min(3, m[0].length - dot - 1) : 0;
    return { num: Number.isFinite(num) ? num : 0, unit: rest, decimals };
  };

  const rawRows = String(p.itemsText || '德国 | 45 | 年\\n日本 | 78 | 年\\n*新中国 | 27 | 年')
    .split(/\\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const parsedItems = rawRows.map((line, idx) => {
    const parts = line.split(/[|｜,，\\t]+/).map((s) => s.trim());
    const rawName = parts[0] || ('项目 ' + (idx + 1));
    const isStarred = rawName.startsWith('*') || highlightSet.has(idx + 1);
    const name = rawName.replace(/^\\*+/, '').trim() || ('项目 ' + (idx + 1));
    const parsedVal = parseNumeric(parts[1] ?? '0');
    const unit = (parts[2] !== undefined && parts[2] !== '') ? parts[2] : (parsedVal.unit || defaultUnit);
    const displayText = parts[3] && parts[3].trim() ? parts[3].trim() : '';
    return {
      name,
      value: Math.max(0, parsedVal.num),
      decimals: parsedVal.decimals,
      unit,
      displayText,
      isAccent: isStarred,
    };
  });

  const items = parsedItems.length >= 2
    ? parsedItems
    : parsedItems.length === 1
      ? [parsedItems[0], { name: '对照项', value: Math.max(10, Math.round(parsedItems[0].value * 0.5)), decimals: 0, unit: parsedItems[0].unit, displayText: '', isAccent: false }]
      : [
          { name: '德国', value: 45, decimals: 0, unit: '年', displayText: '', isAccent: false },
          { name: '日本', value: 78, decimals: 0, unit: '年', displayText: '', isAccent: false },
          { name: '新中国', value: 27, decimals: 0, unit: '年', displayText: '', isAccent: true },
        ];

  const niceCeiling = (maxVal) => {
    if (maxVal <= 0) return 100;
    const padded = maxVal * 1.12;
    const exp = Math.floor(Math.log10(padded));
    const base = Math.pow(10, exp);
    const frac = padded / base;
    let niceFrac = 10;
    if (frac <= 1.2) niceFrac = 1.2;
    else if (frac <= 1.5) niceFrac = 1.5;
    else if (frac <= 2) niceFrac = 2;
    else if (frac <= 2.5) niceFrac = 2.5;
    else if (frac <= 3) niceFrac = 3;
    else if (frac <= 4) niceFrac = 4;
    else if (frac <= 5) niceFrac = 5;
    else if (frac <= 6) niceFrac = 6;
    else if (frac <= 8) niceFrac = 8;
    return niceFrac * base;
  };

  const dataMax = Math.max(1, ...items.map((it) => it.value));
  const customMax = Number(p.maxValue ?? 0);
  const axisMax = customMax > 0 ? Math.max(dataMax, customMax) : niceCeiling(dataMax);

  const parsedItemFrames = String(p.itemFrames || '')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const parsedTimesSec = String(p.itemTimesSec || '0.3, 0.9, 1.5')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const growFrames = Math.max(4, Math.round(Math.max(0.1, Number(p.growDurationSec ?? 0.55)) * fps));
  const startFrames = [];
  for (let i = 0; i < items.length; i++) {
    if (parsedItemFrames.length > 0) {
      if (i < parsedItemFrames.length) startFrames.push(Math.round(parsedItemFrames[i]));
      else startFrames.push((startFrames[i - 1] ?? 0) + Math.round(0.55 * fps));
    } else if (i < parsedTimesSec.length) {
      startFrames.push(Math.round(parsedTimesSec[i] * fps));
    } else {
      startFrames.push(i === 0 ? Math.round(0.3 * fps) : (startFrames[i - 1] + Math.round(0.55 * fps)));
    }
  }

  const enterP = cubicOut(f / 10);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;
  const lastStart = startFrames[startFrames.length - 1] ?? 0;
  const footnoteP = f >= lastStart + growFrames ? 1 : cubicOut((f - (lastStart + Math.round(growFrames * 0.45))) / 10);

  const isVertical = String(p.orientation || 'horizontal') === 'vertical';
  const showGrid = p.showGrid !== false;
  const showValueRoll = p.showValueRoll !== false;
  const posY = Number(p.posY ?? 46);
  const cardScale = Math.max(0.5, Math.min(1.5, Number(p.cardScale ?? 100) / 100));
  const chartTitle = String(p.chartTitle ?? '工业化进程耗时对比').trim();
  const footnote = String(p.footnote || '').trim();

  const formatNum = (val, decimals) => {
    if (decimals > 0) {
      return val.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    return Math.round(val).toLocaleString('en-US');
  };

  const formatAxisTick = (val) => {
    if (axisMax <= 10) return Number(val.toFixed(1)).toString();
    return Math.round(val).toLocaleString('en-US');
  };

  const count = items.length;
  const rowGap = count >= 6 ? 18 : count === 5 ? 22 : 28;
  const barHeight = count >= 6 ? 34 : count === 5 ? 40 : 48;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: resolvedFont }}>
      <div style={{
        position: 'absolute',
        left: '50%',
        top: posY + '%',
        width: 1120,
        maxWidth: '88%',
        transform: 'translate(-50%, -50%) scale(' + cardScale + ') translateY(' + ((1 - enterP) * 18) + 'px)',
        background: bgAlpha > 0 ? hexToRgba(cardBg, bgAlpha) : 'transparent',
        color: inkColor,
        borderRadius: 14,
        border: bgAlpha > 0 ? ('1.5px solid ' + activePreset.border) : 'none',
        borderTop: bgAlpha > 0 ? ('5px solid ' + accentColor) : 'none',
        padding: bgAlpha > 0 ? '34px 44px 30px' : '16px 24px',
        boxShadow: bgAlpha > 0.1 ? activePreset.shadow : 'none',
        textShadow: activePreset.transparent ? '0 2px 10px rgba(0,0,0,0.45)' : 'none',
        opacity: enterP * exitP,
      }}>
        {chartTitle ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 32,
            fontWeight: 800,
            letterSpacing: 0.5,
            marginBottom: isVertical ? 20 : 24,
            color: inkColor,
          }}>
            <span style={{ width: 6, height: 30, borderRadius: 3, background: accentColor, flexShrink: 0 }} />
            <span>{chartTitle}</span>
          </div>
        ) : null}

        {!isVertical ? (
          <div style={{ position: 'relative' }}>
            {showGrid && (
              <div style={{
                position: 'absolute',
                left: 184,
                right: 170,
                top: 0,
                bottom: 28,
                pointerEvents: 'none',
              }}>
                {ticks.map((ratio, ti) => (
                  <div key={ti} style={{
                    position: 'absolute',
                    left: (ratio * 100) + '%',
                    top: 0,
                    bottom: 0,
                    borderLeft: ti === 0 ? ('2px solid ' + mutedInk) : ('1px dashed ' + gridColor),
                    opacity: ti === 0 ? 0.48 : 1,
                  }}>
                    <span style={{
                      position: 'absolute',
                      bottom: -24,
                      left: 0,
                      transform: 'translateX(-50%)',
                      fontSize: 15,
                      fontWeight: 600,
                      color: mutedInk,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}>
                      {formatAxisTick(axisMax * ratio)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: rowGap, paddingBottom: showGrid ? 32 : 4 }}>
              {items.map((it, idx) => {
                const startF = startFrames[idx];
                const rawP = f <= startF ? 0 : f >= startF + growFrames ? 1 : cubicOut((f - startF) / growFrames);
                const labelFade = f <= startF ? 0 : f >= startF + 8 ? 1 : cubicOut((f - startF) / 8);
                const widthPct = clamp01(it.value / Math.max(1e-6, axisMax)) * rawP * 100;
                const displayNum = rawP >= 1 ? it.value : (showValueRoll ? it.value * rawP : it.value);
                const valueStr = rawP >= 1 && it.displayText
                  ? it.displayText
                  : (formatNum(displayNum, it.decimals) + (it.unit ? ' ' + it.unit : ''));
                const barFill = it.isAccent ? accentColor : mutedBarColor;

                return (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{
                      width: 168,
                      flexShrink: 0,
                      textAlign: 'right',
                      fontSize: count >= 5 ? 23 : 26,
                      fontWeight: it.isAccent ? 800 : 700,
                      color: it.isAccent ? accentColor : inkColor,
                      opacity: labelFade,
                      lineHeight: 1.2,
                    }}>
                      {it.name}
                    </div>
                    <div style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 14,
                    }}>
                      <div style={{
                        flex: 1,
                        height: barHeight,
                        background: trackColor,
                        borderRadius: 8,
                        position: 'relative',
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          width: Math.max(0, Math.min(100, widthPct)) + '%',
                          height: '100%',
                          background: barFill,
                          borderRadius: '0 8px 8px 0',
                          boxShadow: it.isAccent ? ('0 4px 14px ' + hexToRgba(accentColor, 0.36)) : 'none',
                        }} />
                      </div>
                      <div style={{
                        width: 156,
                        flexShrink: 0,
                        fontSize: count >= 5 ? 23 : 26,
                        fontWeight: it.isAccent ? 900 : 700,
                        color: it.isAccent ? accentColor : inkColor,
                        fontVariantNumeric: 'tabular-nums',
                        opacity: rawP <= 0.02 ? 0 : 1,
                        whiteSpace: 'nowrap',
                      }}>
                        {valueStr}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'stretch', height: 340 }}>
              <div style={{
                width: 84,
                flexShrink: 0,
                position: 'relative',
                marginRight: 10,
              }}>
                {ticks.map((ratio, ti) => (
                  <div key={ti} style={{
                    position: 'absolute',
                    right: 6,
                    bottom: (ratio * 100) + '%',
                    transform: 'translateY(50%)',
                    fontSize: 16,
                    fontWeight: 600,
                    color: mutedInk,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}>
                    {formatAxisTick(axisMax * ratio)}
                  </div>
                ))}
              </div>

              <div style={{
                flex: 1,
                position: 'relative',
                borderBottom: '2px solid ' + hexToRgba(mutedInk, 0.55),
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-around',
                padding: '0 16px',
              }}>
                {showGrid && ticks.slice(1).map((ratio, ti) => (
                  <div key={ti} style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: (ratio * 100) + '%',
                    borderTop: '1px dashed ' + gridColor,
                    pointerEvents: 'none',
                  }} />
                ))}

                {items.map((it, idx) => {
                  const startF = startFrames[idx];
                  const rawP = f <= startF ? 0 : f >= startF + growFrames ? 1 : cubicOut((f - startF) / growFrames);
                  const heightPct = clamp01(it.value / Math.max(1e-6, axisMax)) * rawP * 86;
                  const displayNum = rawP >= 1 ? it.value : (showValueRoll ? it.value * rawP : it.value);
                  const valueStr = rawP >= 1 && it.displayText
                    ? it.displayText
                    : (formatNum(displayNum, it.decimals) + (it.unit ? ' ' + it.unit : ''));
                  const barFill = it.isAccent ? accentColor : mutedBarColor;
                  const colW = count >= 5 ? 76 : count === 4 ? 92 : 112;

                  return (
                    <div key={idx} style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      height: '100%',
                      flex: 1,
                      position: 'relative',
                      zIndex: 1,
                    }}>
                      <div style={{
                        fontSize: count >= 5 ? 20 : 23,
                        fontWeight: it.isAccent ? 900 : 700,
                        color: it.isAccent ? accentColor : inkColor,
                        fontVariantNumeric: 'tabular-nums',
                        marginBottom: 8,
                        opacity: rawP <= 0.02 ? 0 : 1,
                        whiteSpace: 'nowrap',
                      }}>
                        {valueStr}
                      </div>
                      <div style={{
                        width: colW,
                        height: Math.max(0, Math.min(92, heightPct)) + '%',
                        background: barFill,
                        borderRadius: '8px 8px 0 0',
                        boxShadow: it.isAccent ? ('0 -4px 16px ' + hexToRgba(accentColor, 0.32)) : 'none',
                      }} />
                    </div>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', paddingLeft: 94, paddingRight: 16, marginTop: 12 }}>
              {items.map((it, idx) => {
                const startF = startFrames[idx];
                const labelFade = f <= startF ? 0 : f >= startF + 8 ? 1 : cubicOut((f - startF) / 8);
                return (
                  <div key={idx} style={{
                    flex: 1,
                    textAlign: 'center',
                    fontSize: count >= 5 ? 21 : 24,
                    fontWeight: it.isAccent ? 800 : 700,
                    color: it.isAccent ? accentColor : inkColor,
                    opacity: labelFade,
                    lineHeight: 1.25,
                  }}>
                    {it.name}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {footnote ? (
          <div style={{
            marginTop: 18,
            paddingTop: 12,
            borderTop: '1px solid ' + hexToRgba(mutedInk, 0.22),
            fontSize: 20,
            fontWeight: 600,
            color: mutedInk,
            opacity: footnoteP,
            transform: 'translateY(' + ((1 - footnoteP) * 6) + 'px)',
          }}>
            {footnote}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

// 7. 折线统计图组件
const LINE_CHART_CODE = `const LineChartCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 180);
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
  const springOut = (t) => {
    const x = clamp01(t);
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 - Math.pow(1 - x, 3) * (1 - 1.16 * x) * Math.cos(x * Math.PI * 1.15);
  };

  const fontAliases = {
    '思源宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '衬线体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '思源黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '霞鹜文楷': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
    '楷体': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
  };
  const resolvedFont = fontAliases[String(p.fontFamily || '').trim()] || String(p.fontFamily || '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif');

  const themeKey = String(p.themePreset || 'warm-paper');
  const presets = {
    'warm-paper': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#6b5d4f',
      accent: '#a62121',
      secondary: '#3d5a73',
      tertiary: '#6b7a4b',
      grid: 'rgba(107,93,79,0.22)',
      border: 'rgba(140,122,101,0.38)',
      badgeText: '#fff8ee',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.26)',
    },
    'crimson-archive': {
      cardBg: '#4b0a0e',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      secondary: '#e6a96b',
      tertiary: '#9cb5a0',
      grid: 'rgba(244,236,218,0.18)',
      border: 'rgba(212,175,55,0.38)',
      badgeText: '#1c1816',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.42)',
    },
    'transparent-light': {
      cardBg: '#1c1816',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      secondary: '#e6a96b',
      tertiary: '#9cb5a0',
      grid: 'rgba(244,236,218,0.22)',
      border: 'transparent',
      badgeText: '#1c1816',
      transparent: true,
      shadow: 'none',
    },
    'transparent-dark': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#5c4f42',
      accent: '#a62121',
      secondary: '#3d5a73',
      tertiary: '#6b7a4b',
      grid: 'rgba(92,79,66,0.22)',
      border: 'transparent',
      badgeText: '#fff8ee',
      transparent: true,
      shadow: 'none',
    },
  };
  const activePreset = presets[themeKey] || presets['warm-paper'];
  const normHex = (v) => String(v || '').trim().toLowerCase();
  const pickThemeColor = (propVal, schemaDef, presetVal) => {
    if (themeKey === 'custom') return String(propVal || presetVal);
    if (!propVal || normHex(propVal) === normHex(schemaDef)) return presetVal;
    return String(propVal);
  };

  const cardBg = pickThemeColor(p.cardBgColor, '#f4ecda', activePreset.cardBg);
  const inkColor = pickThemeColor(p.inkColor, '#1c1816', activePreset.ink);
  const accentColor = pickThemeColor(p.accentColor, '#a62121', activePreset.accent);
  const secondaryColor = pickThemeColor(p.mutedColor, '#3d5a73', activePreset.secondary);
  const tertiaryColor = activePreset.tertiary;
  const mutedInk = activePreset.mutedInk;
  const gridColor = activePreset.grid;
  const bgAlpha = activePreset.transparent ? 0 : clamp01(Number(p.cardBgOpacity ?? 96) / 100);

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '').trim();
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return hex;
  };

  const rawXLabels = String(p.xLabels || '1952, 1957, 1965, 1970, 1975, 1979')
    .split(/[,，|｜\\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);

  const rawSeriesLines = String(p.seriesText || '*中国钢产量 | 135, 535, 1223, 1779, 2390, 3448')
    .split(/\\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);

  const parsedSeries = rawSeriesLines.map((line, idx) => {
    const pipeIdx = line.search(/[|｜]/);
    let rawName = '曲线 ' + (idx + 1);
    let valuesRaw = line;
    if (pipeIdx >= 0) {
      rawName = line.slice(0, pipeIdx).trim() || rawName;
      valuesRaw = line.slice(pipeIdx + 1).trim();
    }
    const isPrimary = rawName.startsWith('*') || (idx === 0 && !rawSeriesLines.some((l) => l.trim().startsWith('*')));
    const name = rawName.replace(/^\\*+/, '').trim() || ('曲线 ' + (idx + 1));
    const vals = valuesRaw
      .split(/[,，\\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n));
    return { name, isPrimary, values: vals };
  }).filter((s) => s.values.length > 0);

  const seriesList = parsedSeries.length > 0
    ? parsedSeries
    : [{ name: '中国钢产量', isPrimary: true, values: [135, 535, 1223, 1779, 2390, 3448] }];

  const maxPts = Math.max(2, rawXLabels.length, ...seriesList.map((s) => s.values.length));
  const xLabels = Array.from({ length: maxPts }, (_, i) => rawXLabels[i] || ('T' + (i + 1)));

  const normalizedSeries = seriesList.map((s, sIdx) => {
    const vals = Array.from({ length: maxPts }, (_, i) => (
      i < s.values.length ? s.values[i] : s.values[s.values.length - 1]
    ));
    let color = secondaryColor;
    if (s.isPrimary && sIdx === 0) color = accentColor;
    else if (sIdx === 0) color = accentColor;
    else if (sIdx === 1) color = secondaryColor;
    else color = tertiaryColor;
    return { ...s, values: vals, color };
  });

  const allValues = normalizedSeries.flatMap((s) => s.values);
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const customYMin = Number(p.yMin ?? -1);
  const customYMax = Number(p.yMax ?? -1);

  const niceMax = (v) => {
    if (v <= 0) return 100;
    const padded = v * 1.15;
    const exp = Math.floor(Math.log10(padded));
    const base = Math.pow(10, exp);
    const frac = padded / base;
    let nf = 10;
    if (frac <= 1.2) nf = 1.2;
    else if (frac <= 1.5) nf = 1.5;
    else if (frac <= 2) nf = 2;
    else if (frac <= 2.5) nf = 2.5;
    else if (frac <= 3) nf = 3;
    else if (frac <= 4) nf = 4;
    else if (frac <= 5) nf = 5;
    else if (frac <= 6) nf = 6;
    else if (frac <= 8) nf = 8;
    return nf * base;
  };

  const yMinVal = customYMin >= 0 ? customYMin : (rawMin >= 0 ? 0 : Math.floor(rawMin * 1.1));
  const yMaxVal = customYMax > yMinVal ? customYMax : Math.max(yMinVal + 10, niceMax(rawMax));
  const ySpan = Math.max(1e-6, yMaxVal - yMinVal);

  const drawStartFrame = p.drawStartFrame !== undefined && p.drawStartFrame !== '' && Number.isFinite(Number(p.drawStartFrame)) && Number(p.drawStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.drawStartFrame)))
    : Math.max(0, Math.round(Math.max(0, Number(p.drawStartSec ?? 0.3)) * fps));
  const rawDrawEnd = p.drawEndFrame !== undefined && p.drawEndFrame !== '' && Number.isFinite(Number(p.drawEndFrame)) && Number(p.drawEndFrame) > 0
    ? Math.round(Number(p.drawEndFrame))
    : Math.round(Math.max(0.2, Number(p.drawEndSec ?? 2.4)) * fps);
  const drawEndFrame = Math.max(drawStartFrame + 1, rawDrawEnd);
  const drawP = f <= drawStartFrame ? 0 : f >= drawEndFrame ? 1 : cubicOut((f - drawStartFrame) / (drawEndFrame - drawStartFrame));

  const hlTokens = String(p.highlightNodes ?? '1952, 1979')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const hlCueFramesOverride = String(p.highlightFrames || '')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const hlCueTimesSec = String(p.highlightTimesSec ?? '0.5, 2.3')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const highlightMap = new Map();
  hlTokens.forEach((tok, hIdx) => {
    let idx = xLabels.findIndex((lbl) => lbl === tok);
    if (idx < 0) {
      const n = Number(tok);
      if (Number.isInteger(n) && n >= 1 && n <= maxPts) idx = n - 1;
    }
    if (idx >= 0) {
      let cueFrame;
      if (hIdx < hlCueFramesOverride.length) cueFrame = Math.round(hlCueFramesOverride[hIdx]);
      else if (hIdx < hlCueTimesSec.length) cueFrame = Math.round(hlCueTimesSec[hIdx] * fps);
      else {
        const frac = maxPts > 1 ? idx / (maxPts - 1) : 0;
        cueFrame = Math.round(drawStartFrame + (drawEndFrame - drawStartFrame) * frac);
      }
      highlightMap.set(idx, cueFrame);
    }
  });

  const enterP = cubicOut(f / 10);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;
  const chartTitle = String(p.chartTitle ?? '历年钢产量增长趋势').trim();
  const unit = String(p.unit ?? '万吨').trim();
  const footnote = String(p.footnote || '').trim();
  const curveMode = String(p.curveMode || 'linear');
  const showNodeValues = p.showNodeValues !== false;
  const posY = Number(p.posY ?? 46);
  const cardScale = Math.max(0.5, Math.min(1.5, Number(p.cardScale ?? 100) / 100));

  const svgW = 1040;
  const svgH = 400;
  const padL = 86;
  const padR = 46;
  const padT = 44;
  const padB = 54;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const xOf = (i) => padL + (maxPts > 1 ? (i / (maxPts - 1)) * plotW : plotW * 0.5);
  const yOf = (val) => padT + plotH - clamp01((val - yMinVal) / ySpan) * plotH;

  const buildLinearPath = (pts) => pts.map((pt, i) => (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1)).join(' ');

  // Monotone cubic Hermite spline so smooth curves stay faithful and never overshoot min/max
  const buildSmoothPath = (pts) => {
    if (pts.length <= 2) return buildLinearPath(pts);
    const n = pts.length;
    const dx = [];
    const slopes = [];
    for (let i = 0; i < n - 1; i++) {
      const dxi = Math.max(1e-6, pts[i + 1].x - pts[i].x);
      dx.push(dxi);
      slopes.push((pts[i + 1].y - pts[i].y) / dxi);
    }
    const tangents = [slopes[0]];
    for (let i = 1; i < n - 1; i++) {
      if (slopes[i - 1] * slopes[i] <= 0) tangents.push(0);
      else {
        const w1 = dx[i - 1] + 2 * dx[i];
        const w2 = 2 * dx[i - 1] + dx[i];
        tangents.push((w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]));
      }
    }
    tangents.push(slopes[n - 2]);
    let d = 'M' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (let i = 0; i < n - 1; i++) {
      const hStep = dx[i] / 3;
      const cp1x = pts[i].x + hStep;
      const cp1y = pts[i].y + tangents[i] * hStep;
      const cp2x = pts[i + 1].x - hStep;
      const cp2y = pts[i + 1].y - tangents[i + 1] * hStep;
      d += ' C' + cp1x.toFixed(1) + ' ' + cp1y.toFixed(1) + ', ' + cp2x.toFixed(1) + ' ' + cp2y.toFixed(1) + ', ' + pts[i + 1].x.toFixed(1) + ' ' + pts[i + 1].y.toFixed(1);
    }
    return d;
  };

  const formatVal = (val) => {
    if (Math.abs(val) < 10 && Math.abs(val - Math.round(val)) > 0.01) return val.toFixed(1);
    return Math.round(val).toLocaleString('en-US');
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const clipId = 'line-clip-' + uid;
  const gradId = 'line-area-' + uid;
  const revealW = Math.max(0, plotW * drawP + 16);
  const footNoteP = f >= drawEndFrame ? 1 : cubicOut((f - (drawStartFrame + (drawEndFrame - drawStartFrame) * 0.6)) / 10);

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: resolvedFont }}>
      <div style={{
        position: 'absolute',
        left: '50%',
        top: posY + '%',
        width: 1140,
        maxWidth: '89%',
        transform: 'translate(-50%, -50%) scale(' + cardScale + ') translateY(' + ((1 - enterP) * 18) + 'px)',
        background: bgAlpha > 0 ? hexToRgba(cardBg, bgAlpha) : 'transparent',
        color: inkColor,
        borderRadius: 14,
        border: bgAlpha > 0 ? ('1.5px solid ' + activePreset.border) : 'none',
        borderTop: bgAlpha > 0 ? ('5px solid ' + accentColor) : 'none',
        padding: bgAlpha > 0 ? '32px 44px 28px' : '16px 24px',
        boxShadow: bgAlpha > 0.1 ? activePreset.shadow : 'none',
        textShadow: activePreset.transparent ? '0 2px 10px rgba(0,0,0,0.45)' : 'none',
        opacity: enterP * exitP,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {chartTitle ? (
              <>
                <span style={{ width: 6, height: 30, borderRadius: 3, background: accentColor, flexShrink: 0 }} />
                <span style={{ fontSize: 32, fontWeight: 800, color: inkColor }}>{chartTitle}</span>
              </>
            ) : null}
            {unit ? (
              <span style={{
                fontSize: 17,
                fontWeight: 700,
                color: mutedInk,
                padding: '3px 10px',
                borderRadius: 6,
                background: hexToRgba(mutedInk, 0.12),
              }}>
                单位：{unit}
              </span>
            ) : null}
          </div>

          {normalizedSeries.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              {normalizedSeries.map((s, si) => (
                <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 19, fontWeight: 700, color: inkColor }}>
                  <span style={{ width: 18, height: 4, borderRadius: 2, background: s.color }} />
                  <span>{s.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <svg width="100%" viewBox={'0 0 ' + svgW + ' ' + svgH} style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <clipPath id={clipId}>
              <rect x={padL - 8} y={0} width={revealW} height={svgH} />
            </clipPath>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentColor} stopOpacity="0.24" />
              <stop offset="100%" stopColor={accentColor} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {yTicks.map((ratio, ti) => {
            const y = padT + plotH - ratio * plotH;
            const val = yMinVal + ratio * ySpan;
            return (
              <g key={ti}>
                <line
                  x1={padL}
                  y1={y}
                  x2={padL + plotW}
                  y2={y}
                  stroke={ti === 0 ? hexToRgba(mutedInk, 0.55) : gridColor}
                  strokeWidth={ti === 0 ? 2 : 1.2}
                  strokeDasharray={ti === 0 ? undefined : '6 6'}
                />
                <text
                  x={padL - 12}
                  y={y + 5}
                  textAnchor="end"
                  fill={mutedInk}
                  fontSize="16"
                  fontWeight="600"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatVal(val)}
                </text>
              </g>
            );
          })}

          {xLabels.map((lbl, xi) => {
            const x = xOf(xi);
            const hlCue = highlightMap.get(xi);
            const hlP = hlCue !== undefined ? (f >= hlCue + 10 ? 1 : springOut((f - hlCue) / 10)) : 0;
            const isLit = hlP > 0.2;
            return (
              <g key={xi}>
                {isLit && (
                  <line
                    x1={x}
                    y1={padT}
                    x2={x}
                    y2={padT + plotH}
                    stroke={accentColor}
                    strokeWidth="1.5"
                    strokeDasharray="4 4"
                    opacity={0.45 * clamp01(hlP)}
                  />
                )}
                <line x1={x} y1={padT + plotH} x2={x} y2={padT + plotH + 6} stroke={mutedInk} strokeWidth="1.5" opacity="0.6" />
                <text
                  x={x}
                  y={padT + plotH + 30}
                  textAnchor="middle"
                  fill={isLit ? accentColor : inkColor}
                  fontSize={isLit ? '21' : '18'}
                  fontWeight={isLit ? '800' : '600'}
                >
                  {lbl}
                </text>
              </g>
            );
          })}

          <g clipPath={'url(#' + clipId + ')'}>
            {normalizedSeries.map((s, si) => {
              const pts = s.values.map((v, i) => ({ x: xOf(i), y: yOf(v), val: v }));
              const linePath = curveMode === 'smooth' ? buildSmoothPath(pts) : buildLinearPath(pts);
              const areaPath = linePath + ' L' + pts[pts.length - 1].x.toFixed(1) + ' ' + (padT + plotH) + ' L' + pts[0].x.toFixed(1) + ' ' + (padT + plotH) + ' Z';
              return (
                <g key={si}>
                  {si === 0 && normalizedSeries.length === 1 && (
                    <path d={areaPath} fill={'url(#' + gradId + ')'} />
                  )}
                  <path
                    d={linePath}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={si === 0 ? 5 : 3.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  {pts.map((pt, pi) => {
                    const isHl = si === 0 && highlightMap.has(pi);
                    return (
                      <g key={pi}>
                        <circle
                          cx={pt.x}
                          cy={pt.y}
                          r={si === 0 ? 6 : 4.5}
                          fill={activePreset.transparent ? s.color : cardBg}
                          stroke={s.color}
                          strokeWidth={si === 0 ? 3.5 : 2.5}
                        />
                        {showNodeValues && !isHl && (
                          <text
                            x={pt.x}
                            y={pt.y - 14}
                            textAnchor="middle"
                            fill={si === 0 ? inkColor : mutedInk}
                            fontSize={si === 0 ? '17' : '15'}
                            fontWeight="700"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {formatVal(pt.val)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>

          {normalizedSeries[0].values.map((val, pi) => {
            const hlCue = highlightMap.get(pi);
            if (hlCue === undefined) return null;
            const ptX = xOf(pi);
            const ptY = yOf(val);
            const popP = f >= hlCue + 12 ? 1 : springOut((f - hlCue) / 12);
            if (popP <= 0.02) return null;
            const pillText = formatVal(val) + (unit ? ' ' + unit : '');
            const pillW = Math.max(76, pillText.length * 14 + 26);
            const badgeX = Math.max(padL + pillW / 2, Math.min(padL + plotW - pillW / 2, ptX));
            const badgeY = Math.max(24, ptY - 34);
            return (
              <g key={'hl-' + pi} opacity={clamp01(popP * 1.4)}>
                <circle cx={ptX} cy={ptY} r={14 * popP} fill={hexToRgba(accentColor, 0.22)} />
                <circle cx={ptX} cy={ptY} r={8.5 * clamp01(popP)} fill={accentColor} stroke={activePreset.badgeText} strokeWidth="2.5" />
                <g transform={'translate(' + badgeX + ',' + (badgeY + (1 - popP) * 8) + ')'}>
                  <rect
                    x={-pillW / 2}
                    y={-18}
                    width={pillW}
                    height={32}
                    rx={7}
                    fill={accentColor}
                  />
                  <text
                    x={0}
                    y={4}
                    textAnchor="middle"
                    fill={activePreset.badgeText}
                    fontSize="18"
                    fontWeight="800"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {pillText}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>

        {footnote ? (
          <div style={{
            marginTop: 10,
            paddingTop: 12,
            borderTop: '1px solid ' + hexToRgba(mutedInk, 0.22),
            fontSize: 20,
            fontWeight: 600,
            color: mutedInk,
            opacity: footNoteP,
            transform: 'translateY(' + ((1 - footNoteP) * 6) + 'px)',
          }}>
            {footnote}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

// 8. 扇形图 / 圆环占比图组件
const PIE_CHART_CODE = `const PieChartCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 180);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  const fontAliases = {
    '思源宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '衬线体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '思源黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '霞鹜文楷': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
    '楷体': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
  };
  const resolvedFont = fontAliases[String(p.fontFamily || '').trim()] || String(p.fontFamily || '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif');

  const themeKey = String(p.themePreset || 'warm-paper');
  const presets = {
    'warm-paper': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#6b5d4f',
      accent: '#a62121',
      mutedSlice: '#b5a38d',
      palette: ['#5c6b73', '#c49a52', '#6d7f6e', '#8c6d62', '#7a6f82'],
      border: 'rgba(140,122,101,0.38)',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.26)',
    },
    'crimson-archive': {
      cardBg: '#4b0a0e',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      mutedSlice: '#a3756c',
      palette: ['#7d5654', '#c2a278', '#6e7b7a', '#9e7f5a', '#6d5b6f'],
      border: 'rgba(212,175,55,0.38)',
      transparent: false,
      shadow: '0 22px 54px rgba(0,0,0,0.42)',
    },
    'transparent-light': {
      cardBg: '#1c1816',
      ink: '#f7efe0',
      mutedInk: '#d9c5a3',
      accent: '#d4af37',
      mutedSlice: '#a3756c',
      palette: ['#7d5654', '#c2a278', '#6e7b7a', '#9e7f5a', '#6d5b6f'],
      border: 'transparent',
      transparent: true,
      shadow: 'none',
    },
    'transparent-dark': {
      cardBg: '#f4ecda',
      ink: '#1c1816',
      mutedInk: '#5c4f42',
      accent: '#a62121',
      mutedSlice: '#b5a38d',
      palette: ['#5c6b73', '#c49a52', '#6d7f6e', '#8c6d62', '#7a6f82'],
      border: 'transparent',
      transparent: true,
      shadow: 'none',
    },
  };
  const activePreset = presets[themeKey] || presets['warm-paper'];
  const normHex = (v) => String(v || '').trim().toLowerCase();
  const pickThemeColor = (propVal, schemaDef, presetVal) => {
    if (themeKey === 'custom') return String(propVal || presetVal);
    if (!propVal || normHex(propVal) === normHex(schemaDef)) return presetVal;
    return String(propVal);
  };

  const cardBg = pickThemeColor(p.cardBgColor, '#f4ecda', activePreset.cardBg);
  const inkColor = pickThemeColor(p.inkColor, '#1c1816', activePreset.ink);
  const accentColor = pickThemeColor(p.accentColor, '#a62121', activePreset.accent);
  const mutedSliceColor = pickThemeColor(p.mutedColor, '#b5a38d', activePreset.mutedSlice);
  const mutedInk = activePreset.mutedInk;
  const bgAlpha = activePreset.transparent ? 0 : clamp01(Number(p.cardBgOpacity ?? 96) / 100);

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '').trim();
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return hex;
  };

  const parseSlices = (rawText, fallback) => {
    const rows = String(rawText || fallback)
      .split(/\\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
    const parsed = rows.map((line, idx) => {
      const parts = line.split(/[|｜,，\\t]+/).map((s) => s.trim());
      const rawName = parts[0] || ('类别 ' + (idx + 1));
      const isAccent = rawName.startsWith('*');
      const name = rawName.replace(/^\\*+/, '').trim() || ('类别 ' + (idx + 1));
      const numMatch = String(parts[1] ?? '0').replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/);
      const rawVal = numMatch ? Math.max(0, Number(numMatch[0])) : 0;
      return { name, rawVal, isAccent };
    });
    const nonZero = parsed.length >= 2 ? parsed : [
      { name: '文盲人口', rawVal: 80, isAccent: true },
      { name: '识字人口', rawVal: 20, isAccent: false },
    ];
    const total = nonZero.reduce((sum, s) => sum + s.rawVal, 0);
    const safeTotal = total > 0 ? total : nonZero.length;
    const hasExplicitAccent = nonZero.some((s) => s.isAccent);
    let nonAccentIdx = 0;
    return nonZero.map((s, idx) => {
      const accent = hasExplicitAccent ? s.isAccent : idx === 0;
      let color;
      if (accent) {
        color = accentColor;
      } else {
        color = nonAccentIdx === 0 ? mutedSliceColor : activePreset.palette[(nonAccentIdx - 1) % activePreset.palette.length];
        nonAccentIdx += 1;
      }
      const pct = total > 0 ? (s.rawVal / safeTotal) * 100 : 100 / nonZero.length;
      return { name: s.name, pct, isAccent: accent, color };
    });
  };

  const leftSlices = parseSlices(p.slicesText, '*文盲人口 | 80\\n识字人口 | 20');
  const rightSlices = parseSlices(p.compareSlicesText, '*文盲人口 | 20\\n识字人口 | 80');

  const isDual = String(p.layoutMode || 'dual') === 'dual';
  const isDonut = String(p.chartStyle || 'donut') === 'donut';
  const dualAnimStyle = String(p.dualAnimStyle || 'morph');

  const sweepStartFrame = p.sweepStartFrame !== undefined && p.sweepStartFrame !== '' && Number.isFinite(Number(p.sweepStartFrame)) && Number(p.sweepStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.sweepStartFrame)))
    : Math.max(0, Math.round(Math.max(0, Number(p.sweepStartSec ?? 0.3)) * fps));
  const rawSweepEnd = p.sweepEndFrame !== undefined && p.sweepEndFrame !== '' && Number.isFinite(Number(p.sweepEndFrame)) && Number(p.sweepEndFrame) > 0
    ? Math.round(Number(p.sweepEndFrame))
    : Math.round(Math.max(0.2, Number(p.sweepEndSec ?? 1.4)) * fps);
  const sweepEndFrame = Math.max(sweepStartFrame + 1, rawSweepEnd);
  const sweepP = f <= sweepStartFrame ? 0 : f >= sweepEndFrame ? 1 : cubicOut((f - sweepStartFrame) / (sweepEndFrame - sweepStartFrame));

  const compareStartFrame = p.compareStartFrame !== undefined && p.compareStartFrame !== '' && Number.isFinite(Number(p.compareStartFrame)) && Number(p.compareStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.compareStartFrame)))
    : Math.max(0, Math.round(Math.max(0, Number(p.compareStartSec ?? 1.6)) * fps));
  const rawCompareEnd = p.compareEndFrame !== undefined && p.compareEndFrame !== '' && Number.isFinite(Number(p.compareEndFrame)) && Number(p.compareEndFrame) > 0
    ? Math.round(Number(p.compareEndFrame))
    : Math.round(Math.max(0.2, Number(p.compareEndSec ?? 2.6)) * fps);
  const compareEndFrame = Math.max(compareStartFrame + 1, rawCompareEnd);
  const compareP = f <= compareStartFrame ? 0 : f >= compareEndFrame ? 1 : cubicOut((f - compareStartFrame) / (compareEndFrame - compareStartFrame));

  const enterP = cubicOut(f / 10);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;
  const posY = Number(p.posY ?? 46);
  const cardScale = Math.max(0.5, Math.min(1.5, Number(p.cardScale ?? 100) / 100));
  const chartTitle = String(p.chartTitle ?? '全国文盲率前后变化对比').trim();
  const leftTitle = String(p.leftTitle ?? '1949 年').trim();
  const rightTitle = String(p.rightTitle ?? '1978 年').trim();
  const compareBadge = String(p.compareBadge ?? '↓ 60 个百分点').trim();
  const footnote = String(p.footnote || '').trim();

  const formatPct = (val) => {
    const rounded = Math.round(val * 10) / 10;
    return (Math.abs(rounded - Math.round(rounded)) < 0.05 ? Math.round(rounded) : rounded.toFixed(1)) + '%';
  };

  const polar = (cx, cy, r, deg) => {
    const rad = (deg * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };

  const sectorPath = (cx, cy, rOuter, rInner, startDeg, sweepDeg) => {
    const span = Math.min(359.94, Math.max(0, sweepDeg));
    const endDeg = startDeg + span;
    const largeArc = span > 180 ? 1 : 0;
    const p1 = polar(cx, cy, rOuter, startDeg);
    const p2 = polar(cx, cy, rOuter, endDeg);
    if (rInner <= 0.5) {
      return 'M' + cx.toFixed(2) + ' ' + cy.toFixed(2)
        + ' L' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2)
        + ' A' + rOuter + ' ' + rOuter + ' 0 ' + largeArc + ' 1 ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2) + ' Z';
    }
    const p3 = polar(cx, cy, rInner, endDeg);
    const p4 = polar(cx, cy, rInner, startDeg);
    return 'M' + p1.x.toFixed(2) + ' ' + p1.y.toFixed(2)
      + ' A' + rOuter + ' ' + rOuter + ' 0 ' + largeArc + ' 1 ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2)
      + ' L' + p3.x.toFixed(2) + ' ' + p3.y.toFixed(2)
      + ' A' + rInner + ' ' + rInner + ' 0 ' + largeArc + ' 0 ' + p4.x.toFixed(2) + ' ' + p4.y.toFixed(2) + ' Z';
  };

  const buildGeometry = (slices, cx, cy, rOuter, rInner, totalSweepDeg, explodePx) => {
    let cursor = -90;
    const arcs = [];
    const callouts = [];
    const maxAngle = -90 + Math.max(0, Math.min(360, totalSweepDeg));
    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      const fullSpan = (sl.pct / 100) * 360;
      const sliceEnd = cursor + fullSpan;
      const visEnd = Math.min(sliceEnd, maxAngle);
      const visSpan = Math.max(0, visEnd - cursor);
      const midDeg = cursor + fullSpan / 2;
      const offset = sl.isAccent && explodePx > 0 ? explodePx : 0;
      const ox = offset > 0 ? Math.cos((midDeg * Math.PI) / 180) * offset : 0;
      const oy = offset > 0 ? Math.sin((midDeg * Math.PI) / 180) * offset : 0;
      if (visSpan > 0.08) {
        arcs.push({
          idx: i,
          color: sl.color,
          isFull: visSpan >= 359.9,
          d: visSpan >= 359.9 ? '' : sectorPath(cx + ox, cy + oy, rOuter, rInner, cursor, visSpan),
          cx: cx + ox,
          cy: cy + oy,
        });
      }
      if (sl.pct >= 0.5) {
        const anchor = polar(cx + ox, cy + oy, rOuter + 6, midDeg);
        const knee = polar(cx + ox, cy + oy, rOuter + 28, midDeg);
        const onRight = Math.cos((midDeg * Math.PI) / 180) >= -0.05;
        callouts.push({
          idx: i,
          slice: sl,
          ax: anchor.x,
          ay: anchor.y,
          kx: knee.x,
          ky: knee.y,
          onRight,
          reveal: clamp01((totalSweepDeg - ((cursor + 90) + fullSpan * 0.35)) / 24),
        });
      }
      cursor = sliceEnd;
    }

    // Spread vertical callouts per side so labels never collide
    const adjustSide = (list) => {
      const sorted = list.slice().sort((a, b) => a.ky - b.ky);
      const minGap = 40;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].ky - sorted[i - 1].ky < minGap) {
          sorted[i].ky = sorted[i - 1].ky + minGap;
        }
      }
      return sorted;
    };
    const rightLabels = adjustSide(callouts.filter((c) => c.onRight));
    const leftLabels = adjustSide(callouts.filter((c) => !c.onRight));
    return { arcs, callouts: [...rightLabels, ...leftLabels] };
  };

  const renderChartSvg = (slices, sweepRatio, cx, cy, svgW, svgH, rOuter, explodePx, showNamesInCallout) => {
    const rInner = isDonut ? Math.round(rOuter * 0.56) : 0;
    const geom = buildGeometry(slices, cx, cy, rOuter, rInner, 360 * clamp01(sweepRatio), explodePx);
    const focusSlice = slices.find((s) => s.isAccent) || slices[0];
    const focusDisplayPct = sweepRatio >= 1 ? focusSlice.pct : focusSlice.pct * clamp01(sweepRatio);

    return (
      <svg width="100%" viewBox={'0 0 ' + svgW + ' ' + svgH} style={{ display: 'block', overflow: 'visible' }}>
        <circle cx={cx} cy={cy} r={rOuter} fill={hexToRgba(mutedInk, 0.12)} />
        {isDonut && <circle cx={cx} cy={cy} r={rInner} fill={bgAlpha > 0 ? cardBg : 'transparent'} />}

        {geom.arcs.map((a) => a.isFull ? (
          isDonut ? (
            <circle
              key={a.idx}
              cx={a.cx}
              cy={a.cy}
              r={(rOuter + rInner) / 2}
              fill="none"
              stroke={a.color}
              strokeWidth={rOuter - rInner}
            />
          ) : (
            <circle key={a.idx} cx={a.cx} cy={a.cy} r={rOuter} fill={a.color} />
          )
        ) : (
          <path key={a.idx} d={a.d} fill={a.color} stroke={bgAlpha > 0 ? cardBg : 'rgba(0,0,0,0.22)'} strokeWidth="2.5" strokeLinejoin="round" />
        ))}

        {isDonut && (
          <g opacity={clamp01(sweepRatio * 2.5)}>
            <text
              x={cx}
              y={cy - 4}
              textAnchor="middle"
              fill={accentColor}
              fontSize={isDual ? '38' : '46'}
              fontWeight="900"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatPct(focusDisplayPct)}
            </text>
            <text
              x={cx}
              y={cy + 26}
              textAnchor="middle"
              fill={mutedInk}
              fontSize={isDual ? '18' : '21'}
              fontWeight="700"
            >
              {focusSlice.name}
            </text>
          </g>
        )}

        {geom.callouts.map((c) => {
          const endX = c.onRight ? (c.kx + (showNamesInCallout ? 28 : 20)) : (c.kx - (showNamesInCallout ? 28 : 20));
          const textX = endX + (c.onRight ? 8 : -8);
          const anchor = c.onRight ? 'start' : 'end';
          const op = c.reveal;
          if (op <= 0.02) return null;
          return (
            <g key={c.idx} opacity={op}>
              <polyline
                points={c.ax.toFixed(1) + ',' + c.ay.toFixed(1) + ' ' + c.kx.toFixed(1) + ',' + c.ky.toFixed(1) + ' ' + endX.toFixed(1) + ',' + c.ky.toFixed(1)}
                fill="none"
                stroke={c.slice.isAccent ? accentColor : mutedInk}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx={c.ax} cy={c.ay} r="3.5" fill={c.slice.color} />
              <text
                x={textX}
                y={c.ky + 6}
                textAnchor={anchor}
                fill={c.slice.isAccent ? accentColor : inkColor}
                fontSize={showNamesInCallout ? '20' : '21'}
                fontWeight={c.slice.isAccent ? '800' : '700'}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {showNamesInCallout ? (c.slice.name + ' ' + formatPct(c.slice.pct)) : formatPct(c.slice.pct)}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  // In dual morph mode with matching slice count, interpolate right chart from left -> right during compareP
  const canMorph = isDual && dualAnimStyle === 'morph' && leftSlices.length === rightSlices.length;
  const activeRightSlices = canMorph
    ? rightSlices.map((rs, i) => ({
        ...rs,
        pct: leftSlices[i].pct + (rs.pct - leftSlices[i].pct) * compareP,
      }))
    : rightSlices;
  const rightSweepRatio = canMorph ? sweepP : compareP;

  const legendSlices = isDual
    ? rightSlices.map((rs, idx) => ({
        name: rs.name,
        color: rs.color,
        isAccent: rs.isAccent,
        label: leftSlices[idx] && leftSlices[idx].name === rs.name
          ? (rs.name + '（' + formatPct(leftSlices[idx].pct) + ' → ' + formatPct(rs.pct) + '）')
          : (rs.name + ' ' + formatPct(rs.pct)),
      }))
    : leftSlices.map((ls) => ({
        name: ls.name,
        color: ls.color,
        isAccent: ls.isAccent,
        label: ls.name + ' ' + formatPct(ls.pct),
      }));

  const footTargetFrame = isDual ? compareEndFrame : sweepEndFrame;
  const footNoteP = f >= footTargetFrame ? 1 : cubicOut((f - (sweepStartFrame + Math.round((footTargetFrame - sweepStartFrame) * 0.55))) / 10);

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: resolvedFont }}>
      <div style={{
        position: 'absolute',
        left: '50%',
        top: posY + '%',
        width: isDual ? 1160 : 1000,
        maxWidth: '90%',
        transform: 'translate(-50%, -50%) scale(' + cardScale + ') translateY(' + ((1 - enterP) * 18) + 'px)',
        background: bgAlpha > 0 ? hexToRgba(cardBg, bgAlpha) : 'transparent',
        color: inkColor,
        borderRadius: 14,
        border: bgAlpha > 0 ? ('1.5px solid ' + activePreset.border) : 'none',
        borderTop: bgAlpha > 0 ? ('5px solid ' + accentColor) : 'none',
        padding: bgAlpha > 0 ? '32px 44px 28px' : '16px 24px',
        boxShadow: bgAlpha > 0.1 ? activePreset.shadow : 'none',
        textShadow: activePreset.transparent ? '0 2px 10px rgba(0,0,0,0.45)' : 'none',
        opacity: enterP * exitP,
      }}>
        {chartTitle ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 32,
            fontWeight: 800,
            marginBottom: isDual ? 16 : 8,
            color: inkColor,
          }}>
            <span style={{ width: 6, height: 30, borderRadius: 3, background: accentColor, flexShrink: 0 }} />
            <span>{chartTitle}</span>
          </div>
        ) : null}

        {!isDual ? (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div style={{ width: 820, maxWidth: '100%' }}>
              {renderChartSvg(leftSlices, sweepP, 410, 210, 820, 420, 148, 8, true)}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ flex: 1, textAlign: 'center' }}>
              {leftTitle ? (
                <div style={{ fontSize: 24, fontWeight: 800, color: mutedInk, marginBottom: 4 }}>{leftTitle}</div>
              ) : null}
              {renderChartSvg(leftSlices, sweepP, 210, 165, 420, 330, 114, 5, false)}
            </div>

            <div style={{
              width: 170,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              opacity: clamp01(0.25 + 0.75 * compareP),
            }}>
              <svg width="88" height="36" viewBox="0 0 88 36">
                <line x1="6" y1="18" x2={6 + 60 * Math.max(0.25, compareP)} y2="18" stroke={accentColor} strokeWidth="4.5" strokeLinecap="round" />
                <polygon points="64,8 64,28 84,18" fill={accentColor} />
              </svg>
              {compareBadge ? (
                <div style={{
                  background: accentColor,
                  color: themeKey === 'crimson-archive' || themeKey === 'transparent-light' ? '#1c1816' : '#fff8ee',
                  fontSize: 18,
                  fontWeight: 800,
                  padding: '6px 14px',
                  borderRadius: 999,
                  whiteSpace: 'nowrap',
                  textShadow: 'none',
                  opacity: compareP >= 0.99 ? 1 : clamp01(compareP * 1.4),
                }}>
                  {compareBadge}
                </div>
              ) : null}
            </div>

            <div style={{ flex: 1, textAlign: 'center', opacity: canMorph ? 1 : clamp01(0.2 + 0.8 * rightSweepRatio) }}>
              {rightTitle ? (
                <div style={{ fontSize: 24, fontWeight: 800, color: accentColor, marginBottom: 4 }}>{rightTitle}</div>
              ) : null}
              {renderChartSvg(activeRightSlices, rightSweepRatio, 210, 165, 420, 330, 114, 5, false)}
            </div>
          </div>
        )}

        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: '10px 26px',
          marginTop: 10,
        }}>
          {legendSlices.map((lg, li) => (
            <div key={li} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 20,
              fontWeight: lg.isAccent ? 800 : 600,
              color: lg.isAccent ? accentColor : inkColor,
              fontVariantNumeric: 'tabular-nums',
            }}>
              <span style={{ width: 14, height: 14, borderRadius: 4, background: lg.color, flexShrink: 0 }} />
              <span>{lg.label}</span>
            </div>
          ))}
        </div>

        {footnote ? (
          <div style={{
            marginTop: 16,
            paddingTop: 12,
            borderTop: '1px solid ' + hexToRgba(mutedInk, 0.22),
            fontSize: 20,
            fontWeight: 600,
            color: mutedInk,
            opacity: footNoteP,
            transform: 'translateY(' + ((1 - footNoteP) * 6) + 'px)',
          }}>
            {footnote}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

export const EXPLAINER_CHART_TEMPLATES: Tpl[] = [
  {
    id: 'zuoren-explainer-bar-chart',
    name: '条形 / 柱状统计图',
    category: 'explainer-kits',
    description: '填入 2～6 组“名称 | 数值 | 单位”，自动按真实数值比例伸长柱条，支持横向条形/竖向柱状切换与踩点逐条入场。',
    tags: ['科普', '柱状图', '条形图', '数据对比'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 180,
    props: {
      chartTitle: '工业化进程耗时对比',
      orientation: 'horizontal',
      itemsText: '德国 | 45 | 年\n日本 | 78 | 年\n*新中国 | 27 | 年',
      defaultUnit: '',
      highlightIndex: '',
      itemTimesSec: '0.3, 0.9, 1.5',
      growDurationSec: 0.55,
      itemFrames: '',
      maxValue: 0,
      showGrid: true,
      showValueRoll: true,
      footnote: '注：条形长度按真实数值比例自动计算',
      themePreset: 'warm-paper',
      posY: 46,
      cardScale: 100,
      cardBgOpacity: 96,
      fontFamily: '思源黑体',
      cardBgColor: '#f4ecda',
      inkColor: '#1c1816',
      accentColor: '#a62121',
      mutedColor: '#8f8172',
    },
    propSchema: [
      { key: 'chartTitle', type: 'string', label: '图表标题', defaultValue: '工业化进程耗时对比' },
      {
        key: 'orientation',
        type: 'select',
        label: '图表方向',
        defaultValue: 'horizontal',
        options: [
          { label: '横向条形图', value: 'horizontal' },
          { label: '竖向柱状图', value: 'vertical' },
        ],
      },
      { key: 'itemsText', type: 'text', label: '数据项（每行：名称 | 数值 | 单位；行首加 * 高亮）', defaultValue: '德国 | 45 | 年\n日本 | 78 | 年\n*新中国 | 27 | 年' },
      { key: 'defaultUnit', type: 'string', label: '默认单位（行内未填时使用）', defaultValue: '' },
      { key: 'itemTimesSec', type: 'string', label: '各条入场时间（秒，逗号分隔）', defaultValue: '0.3, 0.9, 1.5' },
      { key: 'growDurationSec', type: 'number', label: '单条伸长时长 (秒)', defaultValue: 0.55, min: 0.15, max: 2.5, step: 0.05 },
      { key: 'footnote', type: 'string', label: '底部注释（选填）', defaultValue: '注：条形长度按真实数值比例自动计算' },
      {
        key: 'themePreset',
        type: 'select',
        label: '配色风格',
        defaultValue: 'warm-paper',
        options: [
          { label: '暖黄宣纸（砖红强调）', value: 'warm-paper' },
          { label: '深红档案（暗金强调）', value: 'crimson-archive' },
          { label: '透明底·浅色字（配深红底）', value: 'transparent-light' },
          { label: '透明底·深色字（配暖纸底）', value: 'transparent-dark' },
          { label: '自定义配色', value: 'custom' },
        ],
      },
      { key: 'posY', type: 'number', label: '画面垂直位置 (%)', defaultValue: 46, min: 15, max: 80, step: 1 },
      { key: 'cardScale', type: 'number', label: '整体缩放 (%)', defaultValue: 100, min: 55, max: 140, step: 5 },
      { key: 'cardBgOpacity', type: 'number', label: '底卡不透明度 (%)', defaultValue: 96, min: 0, max: 100, step: 5 },
      { key: 'cardBgColor', type: 'color', label: '底卡颜色', defaultValue: '#f4ecda' },
      { key: 'inkColor', type: 'color', label: '主文字颜色', defaultValue: '#1c1816' },
      { key: 'accentColor', type: 'color', label: '高亮强调柱色', defaultValue: '#a62121' },
      { key: 'mutedColor', type: 'color', label: '常规对比柱色', defaultValue: '#8f8172' },
      { key: 'highlightIndex', type: 'string', label: '高亮序号（如 3 或 2,3；也可行首加 *）', defaultValue: '' },
      { key: 'itemFrames', type: 'string', label: '踩点：各条入场帧（逗号分隔，优先于秒数）', defaultValue: '' },
      { key: 'maxValue', type: 'number', label: '纵/横轴上限（0=自动取整）', defaultValue: 0, min: 0, step: 10 },
      { key: 'showGrid', type: 'boolean', label: '显示刻度网格线', defaultValue: true },
      { key: 'showValueRoll', type: 'boolean', label: '数字随柱条同步滚动', defaultValue: true },
      { key: 'fontFamily', type: 'string', label: '字体（如 思源黑体 / 思源宋体）', defaultValue: '思源黑体' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#2c1e1c"/>`
      + `<rect x="34" y="26" width="412" height="218" rx="10" fill="#f4ecda"/>`
      + `<rect x="34" y="26" width="412" height="5" fill="#a62121"/>`
      + `<text x="58" y="64" fill="#1c1816" font-size="16" font-weight="800" font-family="Microsoft YaHei,sans-serif">工业化进程耗时对比</text>`
      + `<text x="106" y="108" text-anchor="end" fill="#1c1816" font-size="14" font-weight="700" font-family="Microsoft YaHei,sans-serif">德国</text>`
      + `<rect x="118" y="92" width="142" height="22" rx="4" fill="#8f8172"/>`
      + `<text x="268" y="108" fill="#1c1816" font-size="13" font-weight="700">45 年</text>`
      + `<text x="106" y="148" text-anchor="end" fill="#1c1816" font-size="14" font-weight="700" font-family="Microsoft YaHei,sans-serif">日本</text>`
      + `<rect x="118" y="132" width="246" height="22" rx="4" fill="#8f8172"/>`
      + `<text x="372" y="148" fill="#1c1816" font-size="13" font-weight="700">78 年</text>`
      + `<text x="106" y="188" text-anchor="end" fill="#a62121" font-size="14" font-weight="800" font-family="Microsoft YaHei,sans-serif">新中国</text>`
      + `<rect x="118" y="172" width="88" height="22" rx="4" fill="#a62121"/>`
      + `<text x="214" y="188" fill="#a62121" font-size="14" font-weight="800">27 年</text>`,
    ),
    code: BAR_CHART_CODE,
  },
  {
    id: 'zuoren-explainer-line-chart',
    name: '折线统计图',
    category: 'explainer-kits',
    description: '支持 1～3 组趋势线从左向右动态描线生长，自动生成坐标轴与淡色网格线，并可设置关键节点踩点高亮弹出数值。',
    tags: ['科普', '折线图', '趋势曲线', '增长变化'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 180,
    props: {
      chartTitle: '历年钢产量增长趋势',
      xLabels: '1952, 1957, 1965, 1970, 1975, 1979',
      seriesText: '*中国钢产量 | 135, 535, 1223, 1779, 2390, 3448',
      unit: '万吨',
      curveMode: 'linear',
      drawStartSec: 0.3,
      drawEndSec: 2.4,
      highlightNodes: '1952, 1979',
      highlightTimesSec: '0.5, 2.3',
      drawStartFrame: -1,
      drawEndFrame: -1,
      highlightFrames: '',
      yMin: -1,
      yMax: -1,
      showNodeValues: true,
      footnote: '数据来源：国家统计局历史统计资料',
      themePreset: 'warm-paper',
      posY: 46,
      cardScale: 100,
      cardBgOpacity: 96,
      fontFamily: '思源黑体',
      cardBgColor: '#f4ecda',
      inkColor: '#1c1816',
      accentColor: '#a62121',
      mutedColor: '#3d5a73',
    },
    propSchema: [
      { key: 'chartTitle', type: 'string', label: '图表标题', defaultValue: '历年钢产量增长趋势' },
      { key: 'xLabels', type: 'string', label: '横轴时间标签（逗号分隔）', defaultValue: '1952, 1957, 1965, 1970, 1975, 1979' },
      { key: 'seriesText', type: 'text', label: '折线数据（每行一条：系列名 | v1, v2...；行首 * 主线）', defaultValue: '*中国钢产量 | 135, 535, 1223, 1779, 2390, 3448' },
      { key: 'unit', type: 'string', label: '纵轴单位', defaultValue: '万吨' },
      {
        key: 'curveMode',
        type: 'select',
        label: '连线方式',
        defaultValue: 'linear',
        options: [
          { label: '直线折线', value: 'linear' },
          { label: '微平滑曲线', value: 'smooth' },
        ],
      },
      { key: 'drawStartSec', type: 'number', label: '描线开始时间 (秒)', defaultValue: 0.3, min: 0, max: 60, step: 0.05 },
      { key: 'drawEndSec', type: 'number', label: '描线完成时间 (秒)', defaultValue: 2.4, min: 0.2, max: 60, step: 0.05 },
      { key: 'highlightNodes', type: 'string', label: '重点高亮节点（年份标签或序号，逗号分隔）', defaultValue: '1952, 1979' },
      { key: 'highlightTimesSec', type: 'string', label: '重点节点点亮时间（秒，留空按描线自动触发）', defaultValue: '0.5, 2.3' },
      { key: 'footnote', type: 'string', label: '底部注释（选填）', defaultValue: '数据来源：国家统计局历史统计资料' },
      {
        key: 'themePreset',
        type: 'select',
        label: '配色风格',
        defaultValue: 'warm-paper',
        options: [
          { label: '暖黄宣纸（砖红强调）', value: 'warm-paper' },
          { label: '深红档案（暗金强调）', value: 'crimson-archive' },
          { label: '透明底·浅色字（配深红底）', value: 'transparent-light' },
          { label: '透明底·深色字（配暖纸底）', value: 'transparent-dark' },
          { label: '自定义配色', value: 'custom' },
        ],
      },
      { key: 'posY', type: 'number', label: '画面垂直位置 (%)', defaultValue: 46, min: 15, max: 80, step: 1 },
      { key: 'cardScale', type: 'number', label: '整体缩放 (%)', defaultValue: 100, min: 55, max: 140, step: 5 },
      { key: 'cardBgOpacity', type: 'number', label: '底卡不透明度 (%)', defaultValue: 96, min: 0, max: 100, step: 5 },
      { key: 'cardBgColor', type: 'color', label: '底卡颜色', defaultValue: '#f4ecda' },
      { key: 'inkColor', type: 'color', label: '主文字颜色', defaultValue: '#1c1816' },
      { key: 'accentColor', type: 'color', label: '主折线与高亮色', defaultValue: '#a62121' },
      { key: 'mutedColor', type: 'color', label: '次折线颜色', defaultValue: '#3d5a73' },
      { key: 'drawStartFrame', type: 'number', label: '踩点：描线起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'drawEndFrame', type: 'number', label: '踩点：描线止帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'highlightFrames', type: 'string', label: '踩点：高亮节点帧（逗号分隔）', defaultValue: '' },
      { key: 'yMin', type: 'number', label: '纵轴下限（-1=自动）', defaultValue: -1, min: -1, step: 10 },
      { key: 'yMax', type: 'number', label: '纵轴上限（-1=自动）', defaultValue: -1, min: -1, step: 10 },
      { key: 'showNodeValues', type: 'boolean', label: '显示常规节点数值', defaultValue: true },
      { key: 'fontFamily', type: 'string', label: '字体（如 思源黑体 / 思源宋体）', defaultValue: '思源黑体' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#5e0a0e"/>`
      + `<rect x="34" y="26" width="412" height="218" rx="10" fill="#f4ecda"/>`
      + `<rect x="34" y="26" width="412" height="5" fill="#a62121"/>`
      + `<text x="58" y="64" fill="#1c1816" font-size="16" font-weight="800" font-family="Microsoft YaHei,sans-serif">历年钢产量增长趋势</text>`
      + `<line x1="76" y1="100" x2="412" y2="100" stroke="#8c7a65" stroke-opacity="0.25" stroke-dasharray="4 4"/>`
      + `<line x1="76" y1="150" x2="412" y2="150" stroke="#8c7a65" stroke-opacity="0.25" stroke-dasharray="4 4"/>`
      + `<line x1="76" y1="202" x2="412" y2="202" stroke="#6b5d4f" stroke-width="1.5"/>`
      + `<polyline points="86,196 150,182 214,158 278,136 342,114 402,78" fill="none" stroke="#a62121" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`
      + `<circle cx="86" cy="196" r="5" fill="#a62121" stroke="#fff8ee" stroke-width="1.5"/>`
      + `<circle cx="402" cy="78" r="6" fill="#a62121" stroke="#fff8ee" stroke-width="2"/>`
      + `<rect x="352" y="48" width="72" height="22" rx="5" fill="#a62121"/>`
      + `<text x="388" y="63" text-anchor="middle" fill="#fff8ee" font-size="11" font-weight="800">3,448 万吨</text>`,
    ),
    code: LINE_CHART_CODE,
  },
  {
    id: 'zuoren-explainer-pie-chart',
    name: '扇形 / 圆环占比图',
    category: 'explainer-kits',
    description: '填入 2～6 组“名称 | 占比”，支持单图结构占比与左右双图前后对比（圆环/实心扇形、顺时针扫出或动态比例过渡）。',
    tags: ['科普', '饼图', '圆环图', '占比对比'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 180,
    props: {
      chartTitle: '全国文盲率前后变化对比',
      layoutMode: 'dual',
      chartStyle: 'donut',
      slicesText: '*文盲人口 | 80\n识字人口 | 20',
      leftTitle: '1949 年',
      compareSlicesText: '*文盲人口 | 20\n识字人口 | 80',
      rightTitle: '1978 年',
      compareBadge: '↓ 60 个百分点',
      dualAnimStyle: 'morph',
      sweepStartSec: 0.3,
      sweepEndSec: 1.4,
      compareStartSec: 1.6,
      compareEndSec: 2.6,
      sweepStartFrame: -1,
      sweepEndFrame: -1,
      compareStartFrame: -1,
      compareEndFrame: -1,
      footnote: '注：扇区角度按占比自动计算，支持 2～6 项结构对比',
      themePreset: 'warm-paper',
      posY: 46,
      cardScale: 100,
      cardBgOpacity: 96,
      fontFamily: '思源黑体',
      cardBgColor: '#f4ecda',
      inkColor: '#1c1816',
      accentColor: '#a62121',
      mutedColor: '#b5a38d',
    },
    propSchema: [
      { key: 'chartTitle', type: 'string', label: '图表标题', defaultValue: '全国文盲率前后变化对比' },
      {
        key: 'layoutMode',
        type: 'select',
        label: '布局模式',
        defaultValue: 'dual',
        options: [
          { label: '左右双图前后对比', value: 'dual' },
          { label: '单图占比结构', value: 'single' },
        ],
      },
      {
        key: 'chartStyle',
        type: 'select',
        label: '图表样式',
        defaultValue: 'donut',
        options: [
          { label: '圆环占比图', value: 'donut' },
          { label: '实心扇形图', value: 'pie' },
        ],
      },
      { key: 'slicesText', type: 'text', label: '主图 / 左图占比（每行：名称 | 数值；行首 * 强调）', defaultValue: '*文盲人口 | 80\n识字人口 | 20' },
      { key: 'leftTitle', type: 'string', label: '左图小标题（双图模式）', defaultValue: '1949 年' },
      { key: 'compareSlicesText', type: 'text', label: '右图对比占比（双图模式）', defaultValue: '*文盲人口 | 20\n识字人口 | 80' },
      { key: 'rightTitle', type: 'string', label: '右图小标题（双图模式）', defaultValue: '1978 年' },
      { key: 'compareBadge', type: 'string', label: '中间变化徽章（选填）', defaultValue: '↓ 60 个百分点' },
      { key: 'sweepStartSec', type: 'number', label: '扫出开始时间 (秒)', defaultValue: 0.3, min: 0, max: 60, step: 0.05 },
      { key: 'sweepEndSec', type: 'number', label: '扫出完成时间 (秒)', defaultValue: 1.4, min: 0.2, max: 60, step: 0.05 },
      { key: 'compareStartSec', type: 'number', label: '对比变化开始时间 (秒)', defaultValue: 1.6, min: 0, max: 60, step: 0.05 },
      { key: 'compareEndSec', type: 'number', label: '对比变化完成时间 (秒)', defaultValue: 2.6, min: 0.2, max: 60, step: 0.05 },
      { key: 'footnote', type: 'string', label: '底部注释（选填）', defaultValue: '注：扇区角度按占比自动计算，支持 2～6 项结构对比' },
      {
        key: 'themePreset',
        type: 'select',
        label: '配色风格',
        defaultValue: 'warm-paper',
        options: [
          { label: '暖黄宣纸（砖红强调）', value: 'warm-paper' },
          { label: '深红档案（暗金强调）', value: 'crimson-archive' },
          { label: '透明底·浅色字（配深红底）', value: 'transparent-light' },
          { label: '透明底·深色字（配暖纸底）', value: 'transparent-dark' },
          { label: '自定义配色', value: 'custom' },
        ],
      },
      { key: 'posY', type: 'number', label: '画面垂直位置 (%)', defaultValue: 46, min: 15, max: 80, step: 1 },
      { key: 'cardScale', type: 'number', label: '整体缩放 (%)', defaultValue: 100, min: 55, max: 140, step: 5 },
      { key: 'cardBgOpacity', type: 'number', label: '底卡不透明度 (%)', defaultValue: 96, min: 0, max: 100, step: 5 },
      { key: 'cardBgColor', type: 'color', label: '底卡颜色', defaultValue: '#f4ecda' },
      { key: 'inkColor', type: 'color', label: '主文字颜色', defaultValue: '#1c1816' },
      { key: 'accentColor', type: 'color', label: '重点扇区颜色', defaultValue: '#a62121' },
      { key: 'mutedColor', type: 'color', label: '常规扇区颜色', defaultValue: '#b5a38d' },
      {
        key: 'dualAnimStyle',
        type: 'select',
        label: '双图动画方式',
        defaultValue: 'morph',
        options: [
          { label: '比例动态过渡', value: 'morph' },
          { label: '顺时针依次扫出', value: 'sweep' },
        ],
      },
      { key: 'sweepStartFrame', type: 'number', label: '踩点：扫出起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'sweepEndFrame', type: 'number', label: '踩点：扫出止帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'compareStartFrame', type: 'number', label: '踩点：对比起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'compareEndFrame', type: 'number', label: '踩点：对比止帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'fontFamily', type: 'string', label: '字体（如 思源黑体 / 思源宋体）', defaultValue: '思源黑体' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#2c1e1c"/>`
      + `<rect x="34" y="26" width="412" height="218" rx="10" fill="#f4ecda"/>`
      + `<rect x="34" y="26" width="412" height="5" fill="#a62121"/>`
      + `<text x="58" y="64" fill="#1c1816" font-size="16" font-weight="800" font-family="Microsoft YaHei,sans-serif">全国文盲率前后变化对比</text>`
      + `<circle cx="136" cy="146" r="46" fill="none" stroke="#b5a38d" stroke-width="20"/>`
      + `<circle cx="136" cy="146" r="46" fill="none" stroke="#a62121" stroke-width="20" stroke-dasharray="231 289" transform="rotate(-90 136 146)"/>`
      + `<text x="136" y="152" text-anchor="middle" fill="#a62121" font-size="16" font-weight="900">80%</text>`
      + `<text x="240" y="152" text-anchor="middle" fill="#a62121" font-size="22" font-weight="900">→</text>`
      + `<circle cx="344" cy="146" r="46" fill="none" stroke="#b5a38d" stroke-width="20"/>`
      + `<circle cx="344" cy="146" r="46" fill="none" stroke="#a62121" stroke-width="20" stroke-dasharray="58 289" transform="rotate(-90 344 146)"/>`
      + `<text x="344" y="152" text-anchor="middle" fill="#a62121" font-size="16" font-weight="900">20%</text>`,
    ),
    code: PIE_CHART_CODE,
  },
];
