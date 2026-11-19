import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import { resolveServerPollPercent, submissionBody, type ServerExportContext } from './serverExportRenderOperation';

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [],
};
const options = {
  state,
  projectId: 'range-project',
  projectName: 'Range',
  base: 'range',
  tab: 'video' as const,
  codec: 'h264' as const,
  resolution: '1080p' as const,
  fps: 30,
  startFrame: 12,
  endFrameExclusive: 42,
  requestedVideoBitrate: undefined,
  subtitleFormat: 'srt' as const,
  subtitleCaptions: null,
  nleFormat: 'fcp_xml' as const,
  includeMg: false,
  mgItems: [],
  onClose: () => undefined,
};
const body = submissionBody({ options } as unknown as ServerExportContext, 'video', 'h264', 'op-range');
assert.equal(body.startFrame, 12);
assert.equal(body.endFrameExclusive, 42);
assert.equal(body.operationId, 'op-range');
const full = submissionBody({ options: { ...options, startFrame: undefined, endFrameExclusive: undefined } } as unknown as ServerExportContext, 'video', 'h264', 'op-full');
assert.equal('startFrame' in full, false, 'full export omits range fields');
assert.equal('endFrameExclusive' in full, false, 'full export omits range fields');
assert.equal(
  resolveServerPollPercent(
    { phase: 'preparing', percent: 0 },
    { progress: 10, processedFrames: 797, totalFrames: 79737 },
    'rendering',
  ),
  1,
  'rendering reports real frame percent instead of clamping to server starting 10%',
);
assert.equal(
  resolveServerPollPercent(
    { phase: 'rendering', percent: 7, processedFrames: 5581 },
    { progress: 14, processedFrames: 5600, totalFrames: 79737 },
    'rendering',
  ),
  7,
);
console.log('server export range submission check passed');
