import type { Tpl } from '../types';
import { EXPLAINER_CHART_TEMPLATES } from './explainerChartTemplates';

function makeThumb(svgBody: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270">${svgBody}</svg>`,
  )}`;
}

export interface ScanFocusLayout {
  cx: number;
  cy: number;
  bw: number;
  bh: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ax: number;
  ay: number;
  mx: number;
  my: number;
  ex: number;
  ey: number;
  pointsLeft: boolean;
  labelText: string;
  subText: string;
  hasLabelCard: boolean;
}

export function computeScanFocusLayout(
  props: Record<string, unknown> | undefined,
  w = 1920,
  h = 1080,
): ScanFocusLayout {
  const p = props ?? {};
  const cx = (Number(p.boxX ?? 42) / 100) * w;
  const cy = (Number(p.boxY ?? 48) / 100) * h;
  const bw = Math.max(40, (Number(p.boxW ?? 24) / 100) * w);
  const bh = Math.max(40, (Number(p.boxH ?? 28) / 100) * h);
  const x0 = cx - bw / 2;
  const y0 = cy - bh / 2;
  const x1 = cx + bw / 2;
  const y1 = cy + bh / 2;

  const rawLabel = p.labelText === undefined || p.labelText === null ? '重点目标锁定' : String(p.labelText);
  const labelText = rawLabel.trim();
  const subText = String(p.subText ?? '').trim();
  const hasLabelCard = labelText.length > 0 || subText.length > 0;

  const dir = String(p.leaderDir || p.leaderDirection || 'right');
  const len = Math.max(30, Number(p.leaderLength ?? 110));

  let ax = x1;
  let ay = cy;
  let mx = ax + 24;
  let my = ay - 18;
  let ex = mx + len;
  let ey = my;

  if (dir === 'left') {
    ax = x0;
    ay = cy;
    mx = ax - 24;
    my = ay - 18;
    ex = mx - len;
    ey = my;
  } else if (dir === 'down') {
    ax = cx;
    ay = y1;
    mx = ax + 20;
    my = ay + Math.max(24, len * 0.55);
    ex = mx + Math.max(48, len * 0.7);
    ey = my;
  } else if (dir === 'up') {
    ax = cx;
    ay = y0;
    mx = ax + 20;
    my = ay - Math.max(24, len * 0.55);
    ex = mx + Math.max(48, len * 0.7);
    ey = my;
  }

  const parseEndCoord = (val: unknown): number | null => {
    if (val === undefined || val === null || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, Math.min(100, n)) : null;
  };
  let endXPct = parseEndCoord(p.endX ?? p.targetX ?? p.leaderEndX);
  let endYPct = parseEndCoord(p.endY ?? p.targetY ?? p.leaderEndY);
  if (endXPct === null && endYPct === null && typeof p.endPoint === 'string' && p.endPoint.trim()) {
    const parts = p.endPoint.split(/[,，\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (parts.length >= 2 && parts[0]! >= 0 && parts[1]! >= 0) {
      endXPct = Math.max(0, Math.min(100, parts[0]!));
      endYPct = Math.max(0, Math.min(100, parts[1]!));
    }
  }

  if (endXPct !== null || endYPct !== null) {
    const tx = endXPct !== null ? (endXPct / 100) * w : ex;
    const ty = endYPct !== null ? (endYPct / 100) * h : ey;
    if (tx > x1 + 16) {
      ax = x1;
      ay = cy;
      const dx = tx - ax;
      const dy = ty - ay;
      const diagRun = dx <= 36 ? dx * 0.4 : Math.min(dx * 0.55, Math.max(18, Math.min(Math.abs(dy), dx - 28)));
      mx = ax + Math.max(0, diagRun);
      my = ty;
    } else if (tx < x0 - 16) {
      ax = x0;
      ay = cy;
      const dx = ax - tx;
      const dy = ty - ay;
      const diagRun = dx <= 36 ? dx * 0.4 : Math.min(dx * 0.55, Math.max(18, Math.min(Math.abs(dy), dx - 28)));
      mx = ax - Math.max(0, diagRun);
      my = ty;
    } else {
      ax = cx;
      ay = ty < cy ? y0 : y1;
      const dxAbs = Math.abs(tx - ax);
      const dyAbs = Math.abs(ty - ay);
      const signX = tx >= ax ? 1 : -1;
      if (dxAbs < 12) {
        mx = (ax + tx) / 2;
        my = (ay + ty) / 2;
      } else {
        const diagX = dxAbs <= 32 ? dxAbs * 0.4 : Math.min(dxAbs * 0.45, Math.max(12, Math.min(dyAbs * 0.5, dxAbs - 24)));
        mx = ax + signX * Math.max(0, diagX);
        my = ty;
      }
    }
    ex = tx;
    ey = ty;
  }

  const pointsLeft = ex < ax - 4;
  return {
    cx, cy, bw, bh, x0, y0, x1, y1,
    ax, ay, mx, my, ex, ey,
    pointsLeft, labelText, subText, hasLabelCard,
  };
}

// 1. 重点扫描锁定框（实拍标注框）
const SCAN_FOCUS_CODE = `const ScanFocusCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const w = item.width || 1920;
  const h = item.height || 1080;
  const dur = Math.max(1, item.durationInFrames || 150);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
  const springOut = (t) => {
    const x = clamp01(t);
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 - Math.pow(1 - x, 3) * (1 - 1.15 * x) * Math.cos(x * Math.PI * 1.15);
  };

  const cx = (Number(p.boxX ?? 42) / 100) * w;
  const cy = (Number(p.boxY ?? 48) / 100) * h;
  const bw = Math.max(40, (Number(p.boxW ?? 24) / 100) * w);
  const bh = Math.max(40, (Number(p.boxH ?? 28) / 100) * h);
  const x0 = cx - bw / 2;
  const y0 = cy - bh / 2;

  const lockFrame = p.lockStartFrame !== undefined && p.lockStartFrame !== '' && Number.isFinite(Number(p.lockStartFrame)) && Number(p.lockStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.lockStartFrame)))
    : Math.max(0, Math.round((Number(p.lockStartSec ?? 0.4)) * fps));
  const scanDuration = p.scanDurationFrames !== undefined && Number.isFinite(Number(p.scanDurationFrames)) && Number(p.scanDurationFrames) > 0
    ? Math.max(1, Math.round(Number(p.scanDurationFrames)))
    : (p.scanStartFrame !== undefined && p.scanStartFrame !== '' && Number.isFinite(Number(p.scanStartFrame)) && Number(p.scanStartFrame) >= 0
      ? Math.max(1, lockFrame - Math.max(0, Math.round(Number(p.scanStartFrame))))
      : 12);
  const scanStart = p.scanStartFrame !== undefined && p.scanStartFrame !== '' && Number.isFinite(Number(p.scanStartFrame)) && Number(p.scanStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.scanStartFrame)))
    : Math.max(0, lockFrame - scanDuration);
  const scanEndFrame = Math.max(scanStart + 1, lockFrame);
  const scanP = f < scanStart ? 0 : f <= scanEndFrame ? clamp01((f - scanStart) / Math.max(1, scanEndFrame - scanStart)) : 1;
  const scanVisible = f >= scanStart && f <= scanEndFrame + 2;
  const scanOpacity = f > scanEndFrame ? clamp01(1 - (f - scanEndFrame) / 2) : clamp01(scanP * 3);

  const lockEndSec = Number(p.lockEndSec ?? 0);
  const exitEnd = p.lockEndFrame !== undefined && p.lockEndFrame !== '' && Number.isFinite(Number(p.lockEndFrame)) && Number(p.lockEndFrame) > 0
    ? Math.min(dur, Math.round(Number(p.lockEndFrame)))
    : lockEndSec > 0 ? Math.min(dur, Math.round(lockEndSec * fps)) : dur;
  const exitStart = Math.max(lockFrame + 8, exitEnd - 10);
  const exitOpacity = f >= exitEnd ? 0 : f > exitStart ? clamp01((exitEnd - f) / Math.max(1, exitEnd - exitStart)) : 1;

  const lockP = clamp01((f - lockFrame) / 10);
  const boxSpring = springOut(lockP);
  const boxScale = lockP <= 0 ? 1.22 : 1.22 - 0.22 * boxSpring;
  const boxOpacity = clamp01(lockP * 2.2) * exitOpacity;

  const leaderP = cubicOut((f - (lockFrame + 3)) / 10);
  const labelP = cubicOut((f - (lockFrame + 6)) / 9);

  const fontAliases = {
    '思源宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '宋体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '衬线体': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    '思源黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '黑体': '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
    '霞鹜文楷': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
    '楷体': '"LXGW WenKai TC", "STKaiti", "KaiTi", serif',
  };
  const assetFontPrefix = p.fontAssetId ? 'cc-font-' + Array.from(String(p.fontAssetId)).map((ch) => ch.codePointAt(0).toString(16)).join('-') + ', ' : '';
  const resolvedFont = assetFontPrefix + (fontAliases[String(p.fontFamily || '').trim()] || String(p.fontFamily || '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif'));
  const frameColor = String(p.frameColor || '#f4ecda');
  const accentColor = String(p.accentColor || '#c83228');
  const textColor = String(p.textColor || '#fff8ee');
  const labelBgColor = String(p.labelBgColor || '#1c1816');
  const bgAlpha = clamp01(Number(p.labelBgOpacity ?? 78) / 100);
  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '');
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return labelBgColor;
  };

  const x1 = cx + bw / 2;
  const y1 = cy + bh / 2;
  const dir = String(p.leaderDir || p.leaderDirection || 'right');
  const len = Math.max(30, Number(p.leaderLength ?? 110));
  const arm = Math.max(16, Math.min(44, Math.min(bw, bh) * 0.22));
  const strokeW = 3.5;

  let ax = x1;
  let ay = cy;
  let mx = ax + 24;
  let my = ay - 18;
  let ex = mx + len;
  let ey = my;

  if (dir === 'left') {
    ax = x0;
    ay = cy;
    mx = ax - 24;
    my = ay - 18;
    ex = mx - len;
    ey = my;
  } else if (dir === 'down') {
    ax = cx;
    ay = y1;
    mx = ax + 20;
    my = ay + Math.max(24, len * 0.55);
    ex = mx + Math.max(48, len * 0.7);
    ey = my;
  } else if (dir === 'up') {
    ax = cx;
    ay = y0;
    mx = ax + 20;
    my = ay - Math.max(24, len * 0.55);
    ex = mx + Math.max(48, len * 0.7);
    ey = my;
  }

  const parseEndCoord = (val) => {
    if (val === undefined || val === null || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.max(0, Math.min(100, n)) : null;
  };
  let endXPct = parseEndCoord(p.endX ?? p.targetX ?? p.leaderEndX);
  let endYPct = parseEndCoord(p.endY ?? p.targetY ?? p.leaderEndY);
  if (endXPct === null && endYPct === null && typeof p.endPoint === 'string' && p.endPoint.trim()) {
    const parts = p.endPoint.split(/[,，\\s]+/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (parts.length >= 2 && parts[0] >= 0 && parts[1] >= 0) {
      endXPct = Math.max(0, Math.min(100, parts[0]));
      endYPct = Math.max(0, Math.min(100, parts[1]));
    }
  }

  if (endXPct !== null || endYPct !== null) {
    const tx = endXPct !== null ? (endXPct / 100) * w : ex;
    const ty = endYPct !== null ? (endYPct / 100) * h : ey;
    if (tx > x1 + 16) {
      ax = x1;
      ay = cy;
      const dx = tx - ax;
      const dy = ty - ay;
      const diagRun = dx <= 36 ? dx * 0.4 : Math.min(dx * 0.55, Math.max(18, Math.min(Math.abs(dy), dx - 28)));
      mx = ax + Math.max(0, diagRun);
      my = ty;
    } else if (tx < x0 - 16) {
      ax = x0;
      ay = cy;
      const dx = ax - tx;
      const dy = ty - ay;
      const diagRun = dx <= 36 ? dx * 0.4 : Math.min(dx * 0.55, Math.max(18, Math.min(Math.abs(dy), dx - 28)));
      mx = ax - Math.max(0, diagRun);
      my = ty;
    } else {
      ax = cx;
      ay = ty < cy ? y0 : y1;
      const dxAbs = Math.abs(tx - ax);
      const dyAbs = Math.abs(ty - ay);
      const signX = tx >= ax ? 1 : -1;
      if (dxAbs < 12) {
        mx = (ax + tx) / 2;
        my = (ay + ty) / 2;
      } else {
        const diagX = dxAbs <= 32 ? dxAbs * 0.4 : Math.min(dxAbs * 0.45, Math.max(12, Math.min(dyAbs * 0.5, dxAbs - 24)));
        mx = ax + signX * Math.max(0, diagX);
        my = ty;
      }
    }
    ex = tx;
    ey = ty;
  }

  const pointsLeft = ex < ax - 4;
  const cardStyle = pointsLeft
    ? { right: w - ex + 12, top: ey - 28 }
    : { left: ex + 12, top: ey - 28 };

  const seg1 = Math.hypot(mx - ax, my - ay);
  const seg2 = Math.hypot(ex - mx, ey - my);
  const totalLen = Math.max(1, seg1 + seg2);
  const endDotP = cubicOut((leaderP - 0.65) / 0.35);
  const rawLabel = p.labelText === undefined || p.labelText === null ? '重点目标锁定' : String(p.labelText);
  const labelText = rawLabel.trim();
  const subText = String(p.subText ?? '').trim();
  const hasLabelCard = labelText.length > 0 || subText.length > 0;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: resolvedFont }}>
      {scanVisible && (
        <div style={{
          position: 'absolute',
          left: x0,
          top: y0,
          width: bw,
          height: bh,
          overflow: 'hidden',
          opacity: scanOpacity * exitOpacity,
        }}>
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: scanP * bh - 28,
            height: 28,
            background: 'linear-gradient(to bottom, transparent, ' + accentColor + ')',
            opacity: 0.45,
          }} />
          <div style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: scanP * bh - 2,
            height: 3,
            background: frameColor,
            boxShadow: '0 0 12px ' + accentColor,
          }} />
        </div>
      )}

      {boxOpacity > 0 && (
        <div style={{
          position: 'absolute',
          left: x0,
          top: y0,
          width: bw,
          height: bh,
          opacity: boxOpacity,
          transform: 'scale(' + boxScale + ')',
          transformOrigin: 'center center',
        }}>
          <div style={{
            position: 'absolute',
            inset: 0,
            border: '1px solid ' + frameColor,
            opacity: 0.28,
          }} />
          <svg width={bw} height={bh} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            <polyline points={arm + ',0 0,0 0,' + arm} fill="none" stroke={frameColor} strokeWidth={strokeW} strokeLinecap="square" />
            <polyline points={(bw - arm) + ',0 ' + bw + ',0 ' + bw + ',' + arm} fill="none" stroke={frameColor} strokeWidth={strokeW} strokeLinecap="square" />
            <polyline points={'0,' + (bh - arm) + ' 0,' + bh + ' ' + arm + ',' + bh} fill="none" stroke={frameColor} strokeWidth={strokeW} strokeLinecap="square" />
            <polyline points={(bw - arm) + ',' + bh + ' ' + bw + ',' + bh + ' ' + bw + ',' + (bh - arm)} fill="none" stroke={frameColor} strokeWidth={strokeW} strokeLinecap="square" />
          </svg>
        </div>
      )}

      {leaderP > 0 && exitOpacity > 0 && (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, opacity: exitOpacity, overflow: 'visible' }}>
          <circle cx={ax} cy={ay} r={5 * clamp01(leaderP * 3)} fill={accentColor} stroke={frameColor} strokeWidth={1.5} />
          <polyline
            points={ax + ',' + ay + ' ' + mx + ',' + my + ' ' + ex + ',' + ey}
            fill="none"
            stroke={accentColor}
            strokeWidth={3}
            strokeDasharray={totalLen}
            strokeDashoffset={totalLen * (1 - leaderP)}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {endDotP > 0 && (
            <>
              {!hasLabelCard && (
                <circle
                  cx={ex}
                  cy={ey}
                  r={10 * endDotP}
                  fill="none"
                  stroke={accentColor}
                  strokeWidth={1.5}
                  opacity={0.45 * endDotP}
                />
              )}
              <circle
                cx={ex}
                cy={ey}
                r={(hasLabelCard ? 3.5 : 5.5) * endDotP}
                fill={accentColor}
                stroke={frameColor}
                strokeWidth={hasLabelCard ? 1.2 : 1.8}
              />
            </>
          )}
        </svg>
      )}

      {hasLabelCard && labelP > 0 && exitOpacity > 0 && (
        <div style={{
          position: 'absolute',
          ...cardStyle,
          maxWidth: 460,
          opacity: labelP * exitOpacity,
          transform: 'translateY(' + ((1 - labelP) * 10) + 'px)',
          background: hexToRgba(labelBgColor, bgAlpha),
          borderRadius: 6,
          padding: '10px 16px 10px 14px',
          borderLeft: '4px solid ' + accentColor,
          boxShadow: '0 8px 24px rgba(0,0,0,0.34)',
        }}>
          {labelText ? <div style={{ color: textColor, fontSize: 28, fontWeight: 700, lineHeight: 1.3, whiteSpace: 'pre-wrap' }}>{labelText}</div> : null}
          {subText ? <div style={{ color: textColor, opacity: 0.78, fontSize: 19, marginTop: labelText ? 4 : 0, lineHeight: 1.35, whiteSpace: 'pre-wrap' }}>{subText}</div> : null}
        </div>
      )}
    </AbsoluteFill>
  );
};`;

// 2. 多步箭头流程图组件
const FLOW_STEPS_CODE = `const FlowStepsCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const w = item.width || 1920;
  const h = item.height || 1080;
  const dur = Math.max(1, item.durationInFrames || 180);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
  const springOut = (t) => {
    const x = clamp01(t);
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return 1 - Math.pow(1 - x, 3) * (1 - 1.16 * x) * Math.cos(x * Math.PI * 1.15);
  };

  const rawSteps = String(p.stepsText || '劳动者\\n劳动资料\\n*劳动对象')
    .split(/\\n|→|->/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  const steps = rawSteps.length ? rawSteps : ['步骤一', '步骤二', '步骤三'];

  const highlightSet = new Set(
    String(p.highlightSteps || '')
      .split(/[,，\\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1),
  );

  const parsedStepFrames = String(p.stepFrames || '')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const parsedTimes = String(p.stepTimesSec || '0.2, 1.0, 1.8')
    .split(/[,，\\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const stepStartFrames = [];
  for (let i = 0; i < steps.length; i++) {
    if (parsedStepFrames.length > 0) {
      if (i < parsedStepFrames.length) stepStartFrames.push(Math.round(parsedStepFrames[i]));
      else stepStartFrames.push((stepStartFrames[i - 1] ?? -Math.round(0.5 * fps)) + Math.round(0.7 * fps));
    } else {
      const sec = i < parsedTimes.length ? parsedTimes[i] : ((i > 0 ? stepStartFrames[i - 1] / fps : -0.5) + 0.7);
      stepStartFrames.push(Math.round(sec * fps));
    }
  }

  const exitOpacity = f > dur - 10 ? clamp01((dur - f) / 10) : 1;
  const isVertical = String(p.direction || 'horizontal') === 'vertical';
  const posY = Number(p.posY ?? 50);
  const cardScale = Math.max(0.5, Math.min(1.5, Number(p.cardScale ?? 100) / 100));

  const boxBg = String(p.boxBgColor || '#f4ecda');
  const boxInk = String(p.boxTextColor || '#1c1816');
  const boxBorder = String(p.boxBorderColor || '#8c7a65');
  const accentBg = String(p.accentBgColor || '#a62121');
  const accentInk = String(p.accentTextColor || '#fff8ee');
  const arrowColor = String(p.arrowColor || '#a62121');

  const count = steps.length;
  const boxFontSize = count >= 5 ? 28 : count === 4 ? 32 : 36;
  const padV = count >= 5 ? 16 : 22;
  const padH = count >= 5 ? 24 : 34;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none', fontFamily: (p.fontAssetId ? 'cc-font-' + Array.from(String(p.fontAssetId)).map((ch) => ch.codePointAt(0).toString(16)).join('-') + ', ' : '') + (p.fontFamily || 'Noto Sans SC, sans-serif') }}>
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: posY + '%',
        transform: 'translateY(-50%) scale(' + cardScale + ')',
        display: 'flex',
        flexDirection: isVertical ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: isVertical ? 14 : 18,
        padding: '0 88px',
        opacity: exitOpacity,
      }}>
        {steps.map((rawLabel, idx) => {
          const isAccent = rawLabel.startsWith('*') || highlightSet.has(idx + 1);
          const label = rawLabel.replace(/^\\*+/, '').trim();
          const startFrame = stepStartFrames[idx];
          const boxP = clamp01((f - startFrame) / 10);
          const springVal = springOut(boxP);
          const arrowP = idx > 0 ? cubicOut((f - (startFrame - 4)) / 8) : 0;

          return (
            <React.Fragment key={idx}>
              {idx > 0 && (
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: isVertical ? 36 : 64,
                  height: isVertical ? 48 : 36,
                  flexShrink: 0,
                  opacity: clamp01(arrowP * 2),
                }}>
                  {isVertical ? (
                    <svg width={36} height={48} viewBox="0 0 36 48">
                      <line x1="18" y1="2" x2="18" y2={2 + 34 * arrowP} stroke={arrowColor} strokeWidth="4" strokeLinecap="round" />
                      {arrowP > 0.35 && <polygon points="10,30 26,30 18,45" fill={arrowColor} opacity={clamp01((arrowP - 0.35) / 0.45)} />}
                    </svg>
                  ) : (
                    <svg width={64} height={36} viewBox="0 0 64 36">
                      <line x1="2" y1="18" x2={2 + 44 * arrowP} y2="18" stroke={arrowColor} strokeWidth="4" strokeLinecap="round" />
                      {arrowP > 0.35 && <polygon points="42,9 42,27 60,18" fill={arrowColor} opacity={clamp01((arrowP - 0.35) / 0.45)} />}
                    </svg>
                  )}
                </div>
              )}
              <div style={{
                opacity: clamp01(boxP * 2.4),
                transform: 'scale(' + (0.86 + 0.14 * springVal) + ') translateY(' + ((1 - springVal) * 14) + 'px)',
                background: isAccent ? accentBg : boxBg,
                color: isAccent ? accentInk : boxInk,
                border: '2px solid ' + (isAccent ? accentBg : boxBorder),
                borderRadius: 10,
                padding: padV + 'px ' + padH + 'px',
                minWidth: isVertical ? 340 : 170,
                maxWidth: isVertical ? 680 : Math.floor((w - 280) / count),
                textAlign: 'center',
                fontSize: boxFontSize,
                fontWeight: isAccent ? 800 : 700,
                lineHeight: 1.3,
                boxShadow: isAccent ? '0 14px 32px rgba(166,33,33,0.28)' : '0 10px 24px rgba(0,0,0,0.16)',
                whiteSpace: 'pre-wrap',
              }}>
                {label}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};`;

// 3. 数据滚动对比卡
const DATA_COUNTER_CODE = `const DataCounterCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 150);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  const metricName = String(p.metricName || '钢产量对比');
  const startLabel = String(p.startLabel || '旧数据');
  const endLabel = String(p.endLabel || '新数据');
  const startValue = Number.isFinite(Number(p.startValue)) ? Number(p.startValue) : 15.8;
  const endValue = Number.isFinite(Number(p.endValue)) ? Number(p.endValue) : 3178;
  const unit = String(p.unit ?? '万吨');
  const footnote = String(p.footnote || '');

  const rawDec = Number(p.decimals ?? -1);
  const inferDecimals = (n) => {
    const s = String(n);
    const dot = s.indexOf('.');
    return dot >= 0 ? Math.min(4, s.length - dot - 1) : 0;
  };
  const decimals = rawDec >= 0 ? Math.min(4, Math.round(rawDec)) : Math.max(inferDecimals(startValue), inferDecimals(endValue));

  const rollStartFrame = p.rollStartFrame !== undefined && p.rollStartFrame !== '' && Number.isFinite(Number(p.rollStartFrame)) && Number(p.rollStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.rollStartFrame)))
    : Math.max(0, Math.round(Math.max(0, Number(p.rollStartSec ?? 0.3)) * fps));
  const rawRollEndFrame = p.rollEndFrame !== undefined && p.rollEndFrame !== '' && Number.isFinite(Number(p.rollEndFrame)) && Number(p.rollEndFrame) > 0
    ? Math.round(Number(p.rollEndFrame))
    : Math.round(Math.max(0, Number(p.rollEndSec ?? 1.8)) * fps);
  const rollEndFrame = Math.max(rollStartFrame + 1, rawRollEndFrame);
  const rollP = f <= rollStartFrame
    ? 0
    : f >= rollEndFrame
      ? 1
      : cubicOut((f - rollStartFrame) / (rollEndFrame - rollStartFrame));
  const currentValue = rollP >= 1 ? endValue : rollP <= 0 ? startValue : startValue + (endValue - startValue) * rollP;

  const enterP = cubicOut(f / 10);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;
  const noteP = f >= rollEndFrame
    ? 1
    : cubicOut((f - (rollStartFrame + (rollEndFrame - rollStartFrame) * 0.55)) / 10);

  const cardBg = String(p.cardBgColor || '#f4ecda');
  const bgAlpha = clamp01(Number(p.cardBgOpacity ?? 95) / 100);
  const inkColor = String(p.inkColor || '#1c1816');
  const accentColor = String(p.accentColor || '#a62121');

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '');
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return cardBg;
  };

  const formatNum = (val) => val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none', fontFamily: (p.fontAssetId ? 'cc-font-' + Array.from(String(p.fontAssetId)).map((ch) => ch.codePointAt(0).toString(16)).join('-') + ', ' : '') + (p.fontFamily || 'Noto Sans SC, sans-serif') }}>
      <div style={{
        width: 960,
        maxWidth: '86%',
        background: hexToRgba(cardBg, bgAlpha),
        color: inkColor,
        borderRadius: 14,
        border: '1.5px solid rgba(140,122,101,0.35)',
        borderTop: '5px solid ' + accentColor,
        padding: '38px 48px 34px',
        boxShadow: '0 22px 54px rgba(0,0,0,0.28)',
        opacity: enterP * exitP,
        transform: 'translateY(' + ((1 - enterP) * 20) + 'px)',
      }}>
        <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: 1, opacity: 0.82, marginBottom: 22 }}>
          {metricName}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ flex: 1 }}>
            {startLabel ? <div style={{ fontSize: 20, opacity: 0.62, marginBottom: 6 }}>{startLabel}</div> : null}
            <div style={{ fontSize: 48, fontWeight: 700, opacity: 0.72, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 }}>
              {formatNum(startValue)}
              <span style={{ fontSize: 24, marginLeft: 6, fontWeight: 600 }}>{unit}</span>
            </div>
          </div>

          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', padding: '0 8px' }}>
            <svg width={76} height={36} viewBox="0 0 76 36">
              <line x1="4" y1="18" x2={4 + 52 * clamp01(enterP * 1.4)} y2="18" stroke={accentColor} strokeWidth="4" strokeLinecap="round" />
              <polygon points="52,8 52,28 72,18" fill={accentColor} opacity={enterP} />
            </svg>
          </div>

          <div style={{ flex: 1.25, textAlign: 'right' }}>
            {endLabel ? <div style={{ fontSize: 20, color: accentColor, fontWeight: 600, marginBottom: 6 }}>{endLabel}</div> : null}
            <div style={{ fontSize: 64, fontWeight: 900, color: accentColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
              {formatNum(currentValue)}
              <span style={{ fontSize: 28, marginLeft: 8, fontWeight: 700 }}>{unit}</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 28, height: 12, borderRadius: 999, background: 'rgba(128,112,92,0.22)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: Math.max(2, rollP * 100) + '%',
            borderRadius: 999,
            background: accentColor,
          }} />
        </div>

        {footnote ? (
          <div style={{
            marginTop: 18,
            fontSize: 24,
            fontWeight: 600,
            color: accentColor,
            opacity: noteP,
            transform: 'translateY(' + ((1 - noteP) * 8) + 'px)',
          }}>
            {footnote}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

// 4. 金句逐句点亮卡片
const QUOTE_CARD_CODE = `const QuoteHighlightCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 180);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  const rawLines = String(p.quoteLines || '过去常有人孤立地看生产工具，\\n*但真正起决定作用的是人的劳动与生产关系，\\n这才是历史演进的关键脉络。')
    .split('\\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const lines = rawLines.length ? rawLines : ['请填入需要逐句点亮的引文'];

  const highlightSet = new Set(
    String(p.highlightLines || '')
      .split(/[,，\\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1),
  );
  const strikeSet = new Set(
    String(p.strikeLines || '')
      .split(/[,，\\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1),
  );

  const parsedLineFrames = String(p.lineFrames || '')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const parsedTimes = String(p.lineTimesSec || '')
    .split(/[,，\\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n >= 0);

  const totalSec = Math.max(1, dur / fps);
  const lineStartFrames = [];
  for (let i = 0; i < lines.length; i++) {
    if (parsedLineFrames.length > 0) {
      if (i < parsedLineFrames.length) lineStartFrames.push(Math.round(parsedLineFrames[i]));
      else lineStartFrames.push((lineStartFrames[i - 1] ?? 0) + Math.round(fps));
    } else if (i < parsedTimes.length) {
      lineStartFrames.push(Math.round(parsedTimes[i] * fps));
    } else if (parsedTimes.length === 0) {
      lineStartFrames.push(Math.round((0.2 + (i * (totalSec * 0.68)) / Math.max(1, lines.length)) * fps));
    } else {
      lineStartFrames.push((lineStartFrames[i - 1] ?? 0) + Math.round(fps));
    }
  }

  const dimAlpha = clamp01(Number(p.dimOpacity ?? 28) / 100);
  const fontSize = Math.max(24, Math.min(96, Number(p.fontSize ?? 46)));
  const cardBg = String(p.cardBgColor || '#1c1816');
  const cardAlpha = clamp01(Number(p.cardBgOpacity ?? 72) / 100);
  const inkColor = String(p.inkColor || '#f4ecda');
  const accentColor = String(p.accentColor || '#e0b84c');
  const sourceText = String(p.sourceText || '');

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '');
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return cardBg;
  };

  const enterP = cubicOut(f / 10);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none', fontFamily: (p.fontAssetId ? 'cc-font-' + Array.from(String(p.fontAssetId)).map((ch) => ch.codePointAt(0).toString(16)).join('-') + ', ' : '') + (p.fontFamily || 'Noto Serif SC, serif') }}>
      <div style={{
        width: 1280,
        maxWidth: '84%',
        background: cardAlpha > 0 ? hexToRgba(cardBg, cardAlpha) : 'transparent',
        borderRadius: 10,
        borderLeft: '6px solid ' + accentColor,
        padding: cardAlpha > 0 ? '42px 52px' : '18px 42px',
        boxShadow: cardAlpha > 0.1 ? '0 20px 48px rgba(0,0,0,0.32)' : 'none',
        opacity: enterP * exitP,
        transform: 'translateY(' + ((1 - enterP) * 18) + 'px)',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {lines.map((raw, idx) => {
            const isStrike = raw.startsWith('~') || strikeSet.has(idx + 1);
            const isHighlight = raw.startsWith('*') || highlightSet.has(idx + 1);
            const cleanText = raw.replace(/^[*~]+/, '').trim();
            const startFrame = lineStartFrames[idx];
            const litP = cubicOut((f - startFrame) / 8);
            const strikeP = isStrike ? cubicOut((f - (startFrame + Math.round(0.3 * fps))) / 10) : 0;
            const opacity = dimAlpha + (1 - dimAlpha) * litP;

            return (
              <div key={idx} style={{
                position: 'relative',
                display: 'inline-block',
                alignSelf: 'flex-start',
                fontSize,
                fontWeight: isHighlight ? 800 : 600,
                lineHeight: 1.5,
                color: isHighlight && litP > 0.25 ? accentColor : inkColor,
                opacity: isStrike && strikeP > 0.5 ? opacity * 0.72 : opacity,
              }}>
                <span>{cleanText}</span>
                {isHighlight && litP > 0 && (
                  <span style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: 2,
                    height: 3.5,
                    background: accentColor,
                    borderRadius: 2,
                    transform: 'scaleX(' + litP + ')',
                    transformOrigin: 'left center',
                    opacity: litP,
                  }} />
                )}
                {isStrike && strikeP > 0 && (
                  <span style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '52%',
                    height: 5,
                    background: '#c83228',
                    borderRadius: 3,
                    transform: 'scaleX(' + strikeP + ')',
                    transformOrigin: 'left center',
                  }} />
                )}
              </div>
            );
          })}
        </div>
        {sourceText ? (
          <div style={{ marginTop: 24, textAlign: 'right', fontSize: Math.max(20, fontSize * 0.52), color: inkColor, opacity: 0.75 }}>
            {sourceText}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

// 5. 动态划线批驳卡片
const STRIKE_REFUTE_CODE = `const StrikeRefuteCard = ({item}) => {
  const p = item.props || {};
  const f = useCurrentFrame() + (item.frameOffset || 0);
  const { fps } = useVideoConfig();
  const dur = Math.max(1, item.durationInFrames || 120);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const cubicOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);

  const claimText = String(p.claimText || '“重工业起步只能完全依赖外部援助”');
  const correctionText = String(p.correctionText || '实证：自主积累与内生动员才是主力');
  const startFrame = p.strikeStartFrame !== undefined && p.strikeStartFrame !== '' && Number.isFinite(Number(p.strikeStartFrame)) && Number(p.strikeStartFrame) >= 0
    ? Math.max(0, Math.round(Number(p.strikeStartFrame)))
    : Math.max(0, Math.round((Number(p.strikeStartSec ?? 0.6)) * fps));
  const strikeFrames = p.strikeDurationFrames !== undefined && p.strikeDurationFrames !== '' && Number.isFinite(Number(p.strikeDurationFrames)) && Number(p.strikeDurationFrames) > 0
    ? Math.max(1, Math.round(Number(p.strikeDurationFrames)))
    : Math.max(1, Math.round(Math.max(0.05, Number(p.strikeDurationSec ?? 0.35)) * fps));
  const strikeP = f <= startFrame
    ? 0
    : f >= startFrame + strikeFrames
      ? 1
      : cubicOut((f - startFrame) / strikeFrames);
  const verdictP = f >= startFrame + strikeFrames
    ? 1
    : cubicOut((f - (startFrame + Math.round(strikeFrames * 0.65))) / 8);

  const enterP = cubicOut(f / 9);
  const exitP = f > dur - 10 ? clamp01((dur - f) / 10) : 1;

  const fontSize = Math.max(24, Math.min(120, Number(p.fontSize ?? 56)));
  const textColor = String(p.textColor || '#1c1816');
  const strikeColor = String(p.strikeColor || '#c83228');
  const strikeThickness = Math.max(3, Math.min(20, Number(p.strikeThickness ?? 8)));
  const cardBg = String(p.cardBgColor || '#f4ecda');
  const cardAlpha = clamp01(Number(p.cardBgOpacity ?? 90) / 100);

  const hexToRgba = (hex, a) => {
    const clean = String(hex || '').replace('#', '');
    if (clean.length === 6) {
      const r = parseInt(clean.slice(0, 2), 16);
      const g = parseInt(clean.slice(2, 4), 16);
      const b = parseInt(clean.slice(4, 6), 16);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
      }
    }
    return cardBg;
  };

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none', fontFamily: (p.fontAssetId ? 'cc-font-' + Array.from(String(p.fontAssetId)).map((ch) => ch.codePointAt(0).toString(16)).join('-') + ', ' : '') + (p.fontFamily || 'Noto Sans SC, sans-serif') }}>
      <div style={{
        maxWidth: '84%',
        background: cardAlpha > 0 ? hexToRgba(cardBg, cardAlpha) : 'transparent',
        borderRadius: 12,
        padding: cardAlpha > 0 ? '40px 54px' : '16px 28px',
        boxShadow: cardAlpha > 0.1 ? '0 18px 48px rgba(0,0,0,0.28)' : 'none',
        textAlign: 'center',
        opacity: enterP * exitP,
        transform: 'scale(' + (0.94 + 0.06 * enterP) + ')',
      }}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <span style={{
            fontSize,
            fontWeight: 800,
            lineHeight: 1.3,
            color: textColor,
            opacity: 1 - 0.42 * strikeP,
            whiteSpace: 'pre-wrap',
          }}>
            {claimText}
          </span>
          {strikeP > 0 && (
            <div style={{
              position: 'absolute',
              left: '-2%',
              right: '-2%',
              top: '52%',
              height: strikeThickness,
              background: strikeColor,
              borderRadius: strikeThickness / 2,
              transform: 'translateY(-50%) scaleX(' + strikeP + ')',
              transformOrigin: 'left center',
              boxShadow: '0 2px 8px rgba(200,50,40,0.35)',
            }} />
          )}
        </div>

        {correctionText ? (
          <div style={{
            marginTop: 22,
            display: 'flex',
            justifyContent: 'center',
            opacity: verdictP,
            transform: 'translateY(' + ((1 - verdictP) * 12) + 'px)',
          }}>
            <span style={{
              background: strikeColor,
              color: '#fff8ee',
              fontSize: Math.max(20, Math.round(fontSize * 0.46)),
              fontWeight: 700,
              padding: '8px 22px',
              borderRadius: 6,
            }}>
              {correctionText}
            </span>
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};`;

export const EXPLAINER_TEMPLATES: Tpl[] = [
  {
    id: 'zuoren-explainer-scan-focus',
    name: '重点扫描锁定框',
    category: 'explainer-kits',
    description: '先从上往下扫过亮线，随后四角瞄准框弹性收拢锁定目标，并自动伸出折线标注说明。',
    tags: ['科普', '标注', '扫描框', '实拍'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 150,
    props: {
      labelText: '重点目标锁定',
      subText: '',
      boxX: 42,
      boxY: 48,
      boxW: 24,
      boxH: 28,
      leaderDirection: 'right',
      leaderLength: 110,
      endX: -1,
      endY: -1,
      lockStartSec: 0.4,
      lockEndSec: 0,
      frameColor: '#f4ecda',
      accentColor: '#c83228',
      textColor: '#fff8ee',
      labelBgColor: '#1c1816',
      labelBgOpacity: 78,
    },
    propSchema: [
      { key: 'labelText', type: 'text', label: '说明文字（留空则隐藏底框，仅显示引线+圆点）', defaultValue: '重点目标锁定' },
      { key: 'subText', type: 'string', label: '补充小字（选填）', defaultValue: '' },
      { key: 'boxX', type: 'number', label: '框中心横坐标 (%)', defaultValue: 42, min: 5, max: 95, step: 0.5 },
      { key: 'boxY', type: 'number', label: '框中心纵坐标 (%)', defaultValue: 48, min: 5, max: 95, step: 0.5 },
      { key: 'boxW', type: 'number', label: '框宽度 (%)', defaultValue: 24, min: 4, max: 90, step: 0.5 },
      { key: 'boxH', type: 'number', label: '框高度 (%)', defaultValue: 28, min: 4, max: 90, step: 0.5 },
      {
        key: 'leaderDirection',
        type: 'select',
        label: '引线方向',
        defaultValue: 'right',
        options: [
          { label: '向右引出', value: 'right' },
          { label: '向下引出', value: 'down' },
          { label: '向左引出', value: 'left' },
          { label: '向上引出', value: 'up' },
        ],
      },
      { key: 'leaderLength', type: 'number', label: '引线长度 (px)', defaultValue: 110, min: 30, max: 400, step: 5 },
      { key: 'endX', type: 'number', label: '引线终点横坐标 (% ，-1=按方向自动)', defaultValue: -1, min: -1, max: 100, step: 0.5 },
      { key: 'endY', type: 'number', label: '引线终点纵坐标 (% ，-1=按方向自动)', defaultValue: -1, min: -1, max: 100, step: 0.5 },
      { key: 'lockStartSec', type: 'number', label: '锁定出现时间 (秒)', defaultValue: 0.4, min: 0, max: 60, step: 0.05 },
      { key: 'lockEndSec', type: 'number', label: '锁定消失时间 (秒，0=随片段结束)', defaultValue: 0, min: 0, max: 60, step: 0.05 },
      { key: 'scanStartFrame', type: 'number', label: '踩点：扫描起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'lockStartFrame', type: 'number', label: '踩点：锁定起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'lockEndFrame', type: 'number', label: '踩点：锁定结束帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'fontFamily', type: 'string', label: '字体（如 思源宋体 / 思源黑体）', defaultValue: '思源黑体' },
      { key: 'frameColor', type: 'color', label: '瞄准框颜色', defaultValue: '#f4ecda' },
      { key: 'accentColor', type: 'color', label: '扫描线与引线强调色', defaultValue: '#c83228' },
      { key: 'textColor', type: 'color', label: '标签文字色', defaultValue: '#fff8ee' },
      { key: 'labelBgColor', type: 'color', label: '标签底衬色', defaultValue: '#1c1816' },
      { key: 'labelBgOpacity', type: 'number', label: '标签底衬不透明度 (%)', defaultValue: 78, min: 0, max: 100, step: 5 },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#1c1816"/>`
      + `<path d="M110 105V75H140M230 75H260V105M110 165V195H140M230 195H260V165" stroke="#f4ecda" stroke-width="4" fill="none"/>`
      + `<line x1="110" y1="128" x2="260" y2="128" stroke="#c83228" stroke-width="3"/>`
      + `<polyline points="260,135 288,112 342,112" stroke="#c83228" stroke-width="3" fill="none"/>`
      + `<rect x="346" y="92" width="108" height="40" rx="5" fill="#2b2420" stroke="#c83228" stroke-width="1.5"/>`
      + `<text x="360" y="117" fill="#fff8ee" font-size="14" font-family="Microsoft YaHei,sans-serif">重点标注</text>`,
    ),
    code: SCAN_FOCUS_CODE,
  },
  {
    id: 'zuoren-explainer-flow-steps',
    name: '多步箭头流程图',
    category: 'explainer-kits',
    description: '填入步骤词与时间点，方框与连接箭头跟随讲解节奏逐个弹出（词前加 * 即设为重点框）。',
    tags: ['科普', '流程图', '逻辑链', '箭头'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 180,
    props: {
      stepsText: '劳动者\n劳动资料\n*劳动对象',
      stepTimesSec: '0.2, 1.0, 1.8',
      highlightSteps: '',
      direction: 'horizontal',
      posY: 50,
      cardScale: 100,
      boxBgColor: '#f4ecda',
      boxTextColor: '#1c1816',
      boxBorderColor: '#8c7a65',
      accentBgColor: '#a62121',
      accentTextColor: '#fff8ee',
      arrowColor: '#a62121',
    },
    propSchema: [
      { key: 'stepsText', type: 'text', label: '步骤词列表（每行一步，词前加 * 设为重点框）', defaultValue: '劳动者\n劳动资料\n*劳动对象' },
      { key: 'stepTimesSec', type: 'string', label: '各步弹出时间（秒，逗号分隔）', defaultValue: '0.2, 1.0, 1.8' },
      { key: 'stepFrames', type: 'string', label: '踩点：各步弹出帧（逗号分隔，优先于秒数）', defaultValue: '' },
      { key: 'highlightSteps', type: 'string', label: '重点框序号（如 3 或 2,3；也可词前加 *）', defaultValue: '' },
      {
        key: 'direction',
        type: 'select',
        label: '排列方向',
        defaultValue: 'horizontal',
        options: [
          { label: '横向流程 →', value: 'horizontal' },
          { label: '纵向流程 ↓', value: 'vertical' },
        ],
      },
      { key: 'posY', type: 'number', label: '画面垂直位置 (%)', defaultValue: 50, min: 12, max: 84, step: 1 },
      { key: 'cardScale', type: 'number', label: '整体缩放 (%)', defaultValue: 100, min: 50, max: 150, step: 5 },
      { key: 'boxBgColor', type: 'color', label: '普通框底色', defaultValue: '#f4ecda' },
      { key: 'boxTextColor', type: 'color', label: '普通框字色', defaultValue: '#1c1816' },
      { key: 'boxBorderColor', type: 'color', label: '普通框边线色', defaultValue: '#8c7a65' },
      { key: 'accentBgColor', type: 'color', label: '重点框底色', defaultValue: '#a62121' },
      { key: 'accentTextColor', type: 'color', label: '重点框字色', defaultValue: '#fff8ee' },
      { key: 'arrowColor', type: 'color', label: '箭头颜色', defaultValue: '#a62121' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#eadec5"/>`
      + `<rect x="34" y="108" width="104" height="54" rx="8" fill="#f4ecda" stroke="#8c7a65" stroke-width="2"/>`
      + `<path d="M146 135H172" stroke="#a62121" stroke-width="3"/><polygon points="170,129 182,135 170,141" fill="#a62121"/>`
      + `<rect x="188" y="108" width="104" height="54" rx="8" fill="#f4ecda" stroke="#8c7a65" stroke-width="2"/>`
      + `<path d="M300 135H326" stroke="#a62121" stroke-width="3"/><polygon points="324,129 336,135 324,141" fill="#a62121"/>`
      + `<rect x="342" y="108" width="104" height="54" rx="8" fill="#a62121"/>`
      + `<g font-family="Microsoft YaHei,sans-serif" font-size="14" font-weight="700" text-anchor="middle">`
      + `<text x="86" y="140" fill="#1c1816">劳动者</text>`
      + `<text x="240" y="140" fill="#1c1816">劳动资料</text>`
      + `<text x="394" y="140" fill="#fff8ee">劳动对象</text></g>`,
    ),
    code: FLOW_STEPS_CODE,
  },
  {
    id: 'zuoren-explainer-data-counter',
    name: '数据滚动对比卡',
    category: 'explainer-kits',
    description: '左侧旧数据对比右侧快速跳动增长的新数值，同步拉长进度条并显示增长倍数备注。',
    tags: ['科普', '数据对比', '数字滚动', '进度条'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 150,
    props: {
      metricName: '钢产量对比',
      startLabel: '旧数据',
      startValue: 15.8,
      endLabel: '新数据',
      endValue: 3178,
      unit: '万吨',
      decimals: -1,
      rollStartSec: 0.3,
      rollEndSec: 1.8,
      footnote: '增长约 200 倍',
      cardBgColor: '#f4ecda',
      cardBgOpacity: 95,
      inkColor: '#1c1816',
      accentColor: '#a62121',
    },
    propSchema: [
      { key: 'metricName', type: 'string', label: '指标名称', defaultValue: '钢产量对比' },
      { key: 'startLabel', type: 'string', label: '起始标签（选填）', defaultValue: '旧数据' },
      { key: 'startValue', type: 'number', label: '起始数值', defaultValue: 15.8, step: 0.1 },
      { key: 'endLabel', type: 'string', label: '目标标签（选填）', defaultValue: '新数据' },
      { key: 'endValue', type: 'number', label: '目标数值', defaultValue: 3178, step: 0.1 },
      { key: 'unit', type: 'string', label: '单位', defaultValue: '万吨' },
      { key: 'decimals', type: 'number', label: '小数位数（-1=自动）', defaultValue: -1, min: -1, max: 4, step: 1 },
      { key: 'rollStartSec', type: 'number', label: '滚动开始时间 (秒)', defaultValue: 0.3, min: 0, max: 60, step: 0.05 },
      { key: 'rollEndSec', type: 'number', label: '滚动结束时间 (秒)', defaultValue: 1.8, min: 0.1, max: 60, step: 0.05 },
      { key: 'rollStartFrame', type: 'number', label: '踩点：滚动起始帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'rollEndFrame', type: 'number', label: '踩点：滚动结束帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'footnote', type: 'string', label: '底部备注小字', defaultValue: '增长约 200 倍' },
      { key: 'cardBgColor', type: 'color', label: '卡片底色', defaultValue: '#f4ecda' },
      { key: 'cardBgOpacity', type: 'number', label: '卡片不透明度 (%)', defaultValue: 95, min: 0, max: 100, step: 5 },
      { key: 'inkColor', type: 'color', label: '主文字颜色', defaultValue: '#1c1816' },
      { key: 'accentColor', type: 'color', label: '增长数字与进度条色', defaultValue: '#a62121' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#2c1e1c"/>`
      + `<rect x="44" y="42" width="392" height="186" rx="10" fill="#f4ecda"/>`
      + `<rect x="44" y="42" width="392" height="5" fill="#a62121"/>`
      + `<text x="72" y="82" fill="#1c1816" font-size="15" font-weight="700" font-family="Microsoft YaHei,sans-serif">钢产量对比</text>`
      + `<text x="72" y="138" fill="#594d44" font-size="24" font-weight="700" font-family="Microsoft YaHei,sans-serif">15.8 万吨</text>`
      + `<text x="218" y="136" fill="#a62121" font-size="22" font-weight="900">→</text>`
      + `<text x="262" y="140" fill="#a62121" font-size="30" font-weight="900" font-family="Microsoft YaHei,sans-serif">3,178 万吨</text>`
      + `<rect x="72" y="168" width="336" height="8" rx="4" fill="#d9cbb3"/>`
      + `<rect x="72" y="168" width="268" height="8" rx="4" fill="#a62121"/>`
      + `<text x="72" y="204" fill="#a62121" font-size="14" font-weight="700" font-family="Microsoft YaHei,sans-serif">增长约 200 倍</text>`,
    ),
    code: DATA_COUNTER_CODE,
  },
  {
    id: 'zuoren-explainer-quote-card',
    name: '金句逐句点亮卡片',
    category: 'explainer-kits',
    description: '带左侧竖线的引文卡片，未念到的句子呈暗色，念到时逐句变亮（行首加 * 自动变色加下划线）。',
    tags: ['科普', '金句', '引文', '逐句点亮'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 180,
    props: {
      quoteLines: '过去常有人孤立地看生产工具，\n*但真正起决定作用的是人的劳动与生产关系，\n这才是历史演进的关键脉络。',
      lineTimesSec: '0.2, 1.6, 3.4',
      highlightLines: '',
      strikeLines: '',
      sourceText: '—— 文献摘录',
      dimOpacity: 28,
      fontSize: 46,
      cardBgColor: '#1c1816',
      cardBgOpacity: 72,
      inkColor: '#f4ecda',
      accentColor: '#e0b84c',
    },
    propSchema: [
      { key: 'quoteLines', type: 'text', label: '引文分句（每行一句；行首加 * 重点变色加下划线）', defaultValue: '过去常有人孤立地看生产工具，\n*但真正起决定作用的是人的劳动与生产关系，\n这才是历史演进的关键脉络。' },
      { key: 'lineTimesSec', type: 'string', label: '各句点亮时间（秒，逗号分隔；留空则自动均分）', defaultValue: '0.2, 1.6, 3.4' },
      { key: 'lineFrames', type: 'string', label: '踩点：各句点亮帧（逗号分隔，优先于秒数）', defaultValue: '' },
      { key: 'highlightLines', type: 'string', label: '重点句序号（如 2；也可行首加 *）', defaultValue: '' },
      { key: 'strikeLines', type: 'string', label: '划掉句序号（如 1；也可行首加 ~）', defaultValue: '' },
      { key: 'sourceText', type: 'string', label: '出处署名（选填）', defaultValue: '—— 文献摘录' },
      { key: 'dimOpacity', type: 'number', label: '未念到分句暗度 (%)', defaultValue: 28, min: 10, max: 70, step: 2 },
      { key: 'fontSize', type: 'number', label: '字号 (px)', defaultValue: 46, min: 24, max: 96, step: 2 },
      { key: 'cardBgColor', type: 'color', label: '卡片底衬色', defaultValue: '#1c1816' },
      { key: 'cardBgOpacity', type: 'number', label: '底衬不透明度 (%)', defaultValue: 72, min: 0, max: 100, step: 5 },
      { key: 'inkColor', type: 'color', label: '常规亮字颜色', defaultValue: '#f4ecda' },
      { key: 'accentColor', type: 'color', label: '重点句与竖线颜色', defaultValue: '#e0b84c' },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#5e0a0e"/>`
      + `<rect x="40" y="44" width="400" height="182" rx="8" fill="#1c1816" fill-opacity="0.8"/>`
      + `<rect x="40" y="44" width="5" height="182" fill="#e0b84c"/>`
      + `<g font-family="Microsoft YaHei,sans-serif" font-size="16" font-weight="700">`
      + `<text x="64" y="92" fill="#f4ecda">第一句已被点亮，</text>`
      + `<text x="64" y="132" fill="#e0b84c">第二句重点高亮并加下划线，</text>`
      + `<line x1="64" y1="138" x2="290" y2="138" stroke="#e0b84c" stroke-width="2.5"/>`
      + `<text x="64" y="172" fill="#f4ecda" fill-opacity="0.3">第三句尚未念到呈暗色。</text></g>`,
    ),
    code: QUOTE_CARD_CODE,
  },
  {
    id: 'zuoren-explainer-strike-refute',
    name: '动态划线批驳卡片',
    category: 'explainer-kits',
    description: '在错误观点或旧说法上方从左往右动态划过一道粗横线，做出当场划掉并给出结论的批驳效果。',
    tags: ['科普', '批驳', '划线', '错句划掉'],
    width: 1920,
    height: 1080,
    fps: 30,
    durationInFrames: 120,
    props: {
      claimText: '“重工业起步只能完全依赖外部援助”',
      correctionText: '实证：自主积累与内生动员才是主力',
      strikeStartSec: 0.6,
      strikeDurationSec: 0.35,
      fontSize: 56,
      textColor: '#1c1816',
      strikeColor: '#c83228',
      strikeThickness: 8,
      cardBgColor: '#f4ecda',
      cardBgOpacity: 90,
    },
    propSchema: [
      { key: 'claimText', type: 'text', label: '待划掉的旧说法 / 靶子文字', defaultValue: '“重工业起步只能完全依赖外部援助”' },
      { key: 'correctionText', type: 'string', label: '下方批驳结论（选填）', defaultValue: '实证：自主积累与内生动员才是主力' },
      { key: 'strikeStartSec', type: 'number', label: '开始划线时间 (秒)', defaultValue: 0.6, min: 0, max: 60, step: 0.05 },
      { key: 'strikeDurationSec', type: 'number', label: '划线扫过时长 (秒)', defaultValue: 0.35, min: 0.1, max: 3, step: 0.05 },
      { key: 'strikeStartFrame', type: 'number', label: '踩点：划线起帧（-1=按秒）', defaultValue: -1, min: -1, max: 3600, step: 1 },
      { key: 'strikeDurationFrames', type: 'number', label: '踩点：划线持续帧（-1=按秒）', defaultValue: -1, min: -1, max: 600, step: 1 },
      { key: 'fontSize', type: 'number', label: '主文字号 (px)', defaultValue: 56, min: 24, max: 120, step: 2 },
      { key: 'textColor', type: 'color', label: '原文字色', defaultValue: '#1c1816' },
      { key: 'strikeColor', type: 'color', label: '粗横线与批驳色', defaultValue: '#c83228' },
      { key: 'strikeThickness', type: 'number', label: '划线粗细 (px)', defaultValue: 8, min: 3, max: 20, step: 1 },
      { key: 'cardBgColor', type: 'color', label: '底衬颜色', defaultValue: '#f4ecda' },
      { key: 'cardBgOpacity', type: 'number', label: '底衬不透明度 (%)', defaultValue: 90, min: 0, max: 100, step: 5 },
    ],
    thumb: makeThumb(
      `<rect width="480" height="270" fill="#2d2622"/>`
      + `<rect x="44" y="54" width="392" height="162" rx="10" fill="#f4ecda"/>`
      + `<text x="240" y="122" text-anchor="middle" fill="#1c1816" fill-opacity="0.65" font-size="22" font-weight="800" font-family="Microsoft YaHei,sans-serif">“完全依赖外部援助”</text>`
      + `<line x1="112" y1="114" x2="368" y2="114" stroke="#c83228" stroke-width="6" stroke-linecap="round"/>`
      + `<rect x="116" y="152" width="248" height="32" rx="6" fill="#c83228"/>`
      + `<text x="240" y="173" text-anchor="middle" fill="#fff8ee" font-size="14" font-weight="700" font-family="Microsoft YaHei,sans-serif">实证：内生动员才是主力</text>`,
    ),
    code: STRIKE_REFUTE_CODE,
  },
  ...EXPLAINER_CHART_TEMPLATES,
];
