import type { TimelineState } from '../editor/types';
import {
  summarizeExportPreflight,
  type ExportCompatSpanDetail,
  type ExportRoutePreflight,
} from '../../shared/export-route-plan.mjs';
import type { ExportVideoCodec } from './useExportDialogModel';

export type { ExportCompatSpanDetail, ExportRoutePreflight };

/**
 * Predict how the current timeline will be routed during export using the exact shared
 * `planOverlayHybridExport` rules (`shared/export-route-plan.mjs`).
 * When server capabilities have already probed local media files via `ffprobe`, the server's
 * probed preflight should take precedence over this unprobed snapshot estimate.
 */
export function analyzeExportRoutePreflight(
  state: TimelineState,
  codec: ExportVideoCodec,
  fps: number,
  frameRange?: [number, number],
  scale = 1,
): ExportRoutePreflight {
  return summarizeExportPreflight({
    state,
    codec,
    fps,
    ...(frameRange ? { frameRange } : {}),
    scale,
  });
}
