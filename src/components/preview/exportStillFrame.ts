import type { ProjectDoc, TimelineState } from '../../editor/types';
import { showAppToast } from '../../ui/appToast';

export function formatPreviewTimecode(frame: number, fps: number): string {
  const safeFps = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const clamped = Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0));
  const ff = clamped % safeFps;
  const totalSeconds = Math.floor(clamped / safeFps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function frameFromTrackRatio(ratio: number, maxFrame: number): number {
  const safeMax = Math.max(0, Math.round(maxFrame));
  if (safeMax <= 0) return 0;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return Math.round(clamped * safeMax);
}

export function percentOfTimelineFrame(frame: number, spanFrames: number): number {
  if (!Number.isFinite(spanFrames) || spanFrames <= 0) return 0;
  const clamped = Math.max(0, Math.min(spanFrames, Number.isFinite(frame) ? frame : 0));
  return (clamped / spanFrames) * 100;
}

export function resolvePreviewZoneSpan(
  zoneIn: number | null | undefined,
  zoneOut: number | null | undefined,
  spanFrames: number,
): { leftPct: number; widthPct: number } | null {
  if (zoneIn == null || zoneOut == null || zoneOut <= zoneIn || spanFrames <= 0) return null;
  const leftPct = percentOfTimelineFrame(zoneIn, spanFrames);
  const rightPct = percentOfTimelineFrame(zoneOut, spanFrames);
  if (rightPct <= leftPct) return null;
  return { leftPct, widthPct: rightPct - leftPct };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export interface ExportStillFrameArgs {
  state: TimelineState;
  project: ProjectDoc;
  timelineId: string;
  frame: number;
  projectName?: string;
}

export async function exportCurrentStillFrame({
  state,
  project,
  timelineId,
  frame,
  projectName,
}: ExportStillFrameArgs): Promise<void> {
  const targetFrame = Math.max(0, Math.round(frame));
  const response = await fetch('/render-still', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state,
      project,
      timelineId,
      frames: [targetFrame],
      grid: false,
      fps: state.fps,
      fullResolution: true,
    }),
  });
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string; message?: string };
      reason = payload.error || payload.message || reason;
    } catch { /* keep HTTP status */ }
    throw new Error(`静帧导出失败：${reason}`);
  }
  const payload = (await response.json()) as { frames?: Array<{ frame: number; base64: string }> };
  const imageBase64 = payload.frames?.[0]?.base64;
  if (!imageBase64) throw new Error('静帧导出失败：未返回画面数据');

  const blob = base64ToBlob(imageBase64, 'image/jpeg');
  const url = URL.createObjectURL(blob);
  const tcSlug = formatPreviewTimecode(targetFrame, state.fps).replace(/:/g, '-');
  const safeTitle = (projectName?.trim() || '静帧画面').replace(/[\\/:*?"<>|]/g, '_');
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeTitle}_${tcSlug}.jpg`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showAppToast('已导出当前帧静帧画面');
}
