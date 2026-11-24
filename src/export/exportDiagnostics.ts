import type { ExportEngineInfo, ExportRenderDiagnostics, Translate } from './exportWorkflowTypes';

const ROUTE_LABELS: Record<ExportRenderDiagnostics['route'], string> = {
  'direct-cut': '极速直切',
  hybrid: '高速混合导出',
  remotion: '完整逐帧渲染',
};

const DECLINE_REASON_LABELS: Record<string, string> = {
  transitions: '含特殊转场效果',
  'item-retimed': '含极端变速片段',
  'audio-retimed': '含极端变速音频',
  'composition-mosaic': '含动画或上层区域马赛克',
  'video-clip-effects': '含特殊画面滤镜或关键帧动画',
  'video-visual-fade': '含叠加冲突的画面淡入淡出',
  'transform-rotation-or-radius': '含画面旋转或圆角裁剪',
  'nested-sequence': '含嵌套子序列',
  'overlay-below-video': '字幕或贴图位于视频轨下方',
  'overlapping-base-video': '多路视频同时叠放（画中画）',
  'video-overlap': '多路视频重叠画面',
  'source-metadata': '源素材封装或音轨异常',
  'nonlocal-source': '含非本地素材',
  'render-mode': '非 H.264 默认导出模式',
  'item-speech-edited': '含文稿删词或气口精修片段',
  'audio-processing': '含音频特效或曲线关键帧',
  'audio-ducking': '含闪避音轨处理',
  'overlays-or-transitions': '含叠加图层或转场',
  'not-plain-single-track': '非单轨纯视频拼接',
  'clip-processing': '含片段滤镜或变换',
  'dense-title-windows': '密集文字叠加区间',
};

export function formatDiagnosticsDuration(ms: number, t: Translate): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return t('{n}毫秒', { n: safeMs });
  const totalSeconds = Math.round(safeMs / 1000);
  if (totalSeconds < 60) return t('{n}秒', { n: totalSeconds });
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0
    ? t('{m}分{s}秒', { m: minutes, s: seconds })
    : t('{m}分', { m: minutes });
}

export function formatDeclineReason(reason: string | undefined, t: Translate): string | null {
  if (!reason) return null;
  if (reason in DECLINE_REASON_LABELS) return t(DECLINE_REASON_LABELS[reason]!);
  if (reason.startsWith('unsupported-kind:')) {
    return t('含特殊图层 ({kind})', { kind: reason.slice('unsupported-kind:'.length) });
  }
  return t('工程包含暂不支持直出的效果');
}

export interface FormattedExportDiagnostics {
  summary: string;
  details: string[];
}

export function formatExportDiagnostics(
  diagnostics: ExportRenderDiagnostics | null | undefined,
  encoder: ExportEngineInfo | null | undefined,
  t: Translate,
): FormattedExportDiagnostics | null {
  if (!diagnostics) return null;
  const routeLabel = t(ROUTE_LABELS[diagnostics.route] ?? diagnostics.route);
  const parts: string[] = [t('路线：{route}', { route: routeLabel })];

  if (diagnostics.route === 'hybrid' && (diagnostics.compatFrames ?? 0) > 0) {
    const reasonText = diagnostics.compatReasons?.length
      ? diagnostics.compatReasons.map((r) => formatDeclineReason(r, t)).filter(Boolean).join('、')
      : '';
    parts[0] = reasonText
      ? t('路线：分段混合导出（含 {n} 帧精细渲染：{reason}）', { n: diagnostics.compatFrames ?? 0, reason: reasonText })
      : t('路线：分段混合导出（含 {n} 帧精细渲染）', { n: diagnostics.compatFrames ?? 0 });
  } else if (diagnostics.route === 'remotion' && diagnostics.fallbackReasons?.hybrid) {
    const reasonText = formatDeclineReason(diagnostics.fallbackReasons.hybrid, t);
    if (reasonText) parts[0] = t('路线：{route}（因{reason}未走高速通道）', { route: routeLabel, reason: reasonText });
  }

  if (encoder) {
    parts.push(encoder.hardware ? t('硬件编码 ({label})', { label: encoder.label }) : t('软件编码 ({label})', { label: encoder.label }));
  }

  if (Number.isFinite(diagnostics.timingsMs?.total)) {
    parts.push(t('耗时 {time}', { time: formatDiagnosticsDuration(diagnostics.timingsMs.total, t) }));
  }

  const details: string[] = [];
  const { plates, encode, audio, mux } = diagnostics.timingsMs ?? {};
  if (plates !== undefined) details.push(t('叠加贴图：{time}', { time: formatDiagnosticsDuration(plates, t) }));
  if (encode !== undefined) details.push(t('视频编码：{time}', { time: formatDiagnosticsDuration(encode, t) }));
  if (audio !== undefined) details.push(t('音频混音：{time}', { time: formatDiagnosticsDuration(audio, t) }));
  if (mux !== undefined) details.push(t('成品封装：{time}', { time: formatDiagnosticsDuration(mux, t) }));
  if (diagnostics.workers !== undefined) {
    details.push(
      diagnostics.concurrencyFallback
        ? t('并行分段：{n} 路（已自动降载防显存不足）', { n: diagnostics.workers })
        : t('并行分段：{n} 路', { n: diagnostics.workers }),
    );
  }
  if (diagnostics.plateCount !== undefined && diagnostics.totalFrames !== undefined) {
    details.push(t('叠加帧数：{plates} / {total}', { plates: diagnostics.plateCount, total: diagnostics.totalFrames }));
  }

  return {
    summary: parts.join(' · '),
    details,
  };
}
