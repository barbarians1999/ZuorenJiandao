import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { TimelineItem, TimelineState } from '../editor/types';
import { newManualCueIdentity, newTranscriptGeneration } from '../transcript/identity';
import { buildCaptionPages } from './captionPages';
import { buildCues } from './captionCues';
import { planCaptionCueEdit } from './captionCueEditing';
import { captionDataSignature } from './captionDraftRecovery';
import { resolveCaptionSelection } from './captionSelection';
import { projectCaptionSourceSpans } from './captionSourceSpans';
import { resolveEntryProjection } from './resolve';
import type { CaptionDisplayCueEdit, CaptionsData } from './types';

function referenceStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : referenceStableJson(item))).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${referenceStableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function referenceCaptionSignature(value: unknown): string {
  const json = referenceStableJson(value);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < json.length; i += 1) {
    const code = json.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

// 1. Streaming captionDataSignature matches reference stableJson byte-for-byte.
{
  const complexSample = {
    b: [1, undefined, '中文🧪', { z: true, skip: undefined, a: null }],
    a: {
      template: 'plain',
      nested: [{ text: 'hello "world"\nnext', start: 0, end: 500 }],
    },
  };
  assert.equal(captionDataSignature(complexSample), referenceCaptionSignature(complexSample));
  assert.equal(captionDataSignature(undefined), referenceCaptionSignature(undefined));
}

// 2. 1,000 manual cues: index accuracy, WeakMap cache reuse, and fast selection lookup.
const manualWords = Array.from({ length: 1000 }, (_, index) => ({
  id: `cue_${index}`,
  text: `第 ${index} 句字幕内容`,
  start: index * 1000,
  end: index * 1000 + 800,
}));
const manualCaptions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceMode: 'item',
  sourceEntries: [{ id: 'manual-lane', itemId: 'manual:manual-lane', words: manualWords }],
};
const manualItems: TimelineItem[] = [];
const tManualStart = performance.now();
const manualPages = buildCaptionPages(manualCaptions, manualItems, 30);
const manualRows = buildCues(manualCaptions, manualItems, 30);
const manualColdMs = performance.now() - tManualStart;
assert.equal(manualPages.length, 1000);
assert.equal(manualRows.length, 1000);
assert(manualRows.every((row, index) => row.manual && row.manualIndex === index), 'manualIndex matches exact positions');
assert.equal(buildCaptionPages(manualCaptions, manualItems, 30), manualPages, 'buildCaptionPages hits WeakMap cache');
assert.equal(buildCues(manualCaptions, manualItems, 30), manualRows, 'buildCues hits WeakMap cache');

const manualState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: manualItems,
  trackOrder: ['C1'],
  tracks: { C1: { kind: 'caption', captions: manualCaptions } },
};
const resolvedLast = resolveCaptionSelection(manualState, { trackId: 'C1', kind: 'manual', laneId: 'manual-lane', cueId: 'cue_999' });
assert.equal(resolvedLast?.target.kind, 'manual');
assert.equal(resolvedLast?.target.cueIndex, 999);

// 3. 3,000-word audio ASR transcript with 100 displayCueEdits + 100 wordOverrides.
const audioWords = Array.from({ length: 3000 }, (_, index) => ({
  id: `w_${index}`,
  text: index % 8 === 7 ? `词${index}。` : `词${index}`,
  start: index * 200,
  end: index * 200 + 160,
}));
const audioItem: TimelineItem = {
  id: 'audio-asr',
  track: 'A1',
  kind: 'audio',
  name: 'ASR Audio',
  src: '/media/asr.mp3',
  startFrame: 0,
  durationInFrames: 18000,
  ...newTranscriptGeneration(audioWords),
};
const entry = { id: 'asr-lane', itemId: audioItem.id };
const projection = resolveEntryProjection(entry, [audioItem], 30);
const wordOverrides: CaptionsData['wordOverrides'] = {};
const displayCueEdits: CaptionDisplayCueEdit[] = [];
for (let i = 0; i < 100; i += 1) {
  const idx = 2000 + i * 2;
  const wordRef = projection.wordRefs[idx]!;
  wordOverrides[idx] = { wordRef, text: `改${i}` };
}
for (let i = 0; i < 100; i += 1) {
  const baseIdx = i * 4;
  const spanRefs = [projection.wordRefs[baseIdx]!, projection.wordRefs[baseIdx + 1]!];
  const spans = spanRefs.map((wordRef, offset) => ({
    wordRef,
    startMs: audioWords[baseIdx + offset]!.start,
    endMs: audioWords[baseIdx + offset]!.end,
    sourceText: audioWords[baseIdx + offset]!.text,
  }));
  displayCueEdits.push({
    id: newManualCueIdentity(),
    coveredWordRefs: spanRefs,
    parts: [{ id: `part_${i}`, text: `精修句${i}`, sourceSpans: spans }],
  });
}
const asrCaptions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceMode: 'item',
  wordOverrides,
  sourceEntries: [{ ...entry, displayCueEdits }],
};
const tAsrStart = performance.now();
const asrRows = buildCues(asrCaptions, [audioItem], 30);
const asrColdMs = performance.now() - tAsrStart;
assert(asrRows.length > 100, 'ASR cues built cleanly');
assert.equal(asrRows[0]?.text, '精修句0');

const tSaveStart = performance.now();
const saveResult = planCaptionCueEdit({
  captions: asrCaptions,
  items: [audioItem],
  fps: 30,
  rows: asrRows,
  rowIndex: 0,
  action: 'save',
  text: '精修句0-已更新',
});
const saveMs = performance.now() - tSaveStart;
assert(saveResult.patch, 'planCaptionCueEdit save succeeds');
const savedAsrRows = buildCues({ ...asrCaptions, ...saveResult.patch }, [audioItem], 30);
assert.equal(savedAsrRows[0]?.text, '精修句0-已更新');

const splitResult = planCaptionCueEdit({
  captions: { ...asrCaptions, ...saveResult.patch },
  items: [audioItem],
  fps: 30,
  rows: savedAsrRows,
  rowIndex: 0,
  action: 'split',
  text: '精修句0-已更新',
  caret: 4,
});
assert(splitResult.patch, splitResult.reason ?? 'planCaptionCueEdit split succeeds');
const spans = projectCaptionSourceSpans(audioItem, displayCueEdits[0]!.parts[0]!.sourceSpans, 30);
assert.equal(spans.length, 2);

// 4. CaptionTrackLane visibleWindow virtualization via Vite SSR.
const localeId = '\0caption-perf-test-locale';
const server = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
  plugins: [{
    name: 'caption-perf-test-locale',
    enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) { return id === localeId ? 'export const useT = () => (text) => text; export const t = (text) => text; export const tData = (text) => text;' : null; },
  }],
});
try {
  const { CaptionTrackLane } = await server.ssrLoadModule('/src/captions/CaptionTrackLane.tsx');
  const laneProps = {
    state: manualState,
    captions: manualCaptions,
    trackId: 'C1',
    playheadFrame: 0,
    px: 2,
    rowHeight: 36,
    hidden: false,
    locked: false,
    snapping: true,
    trackFromClientY: () => 'C1',
    onUpdate: () => undefined,
    onMove: () => undefined,
    onDelete: () => undefined,
  };
  const windowedHtml = renderToStaticMarkup(createElement(CaptionTrackLane, {
    ...laneProps,
    visibleWindow: { startFrame: 0, endFrame: 300 },
  }));
  const windowedCount = (windowedHtml.match(/class="cc-caption-track-cue/g) ?? []).length;
  assert(windowedCount >= 8 && windowedCount <= 25, `expected windowed cues between 8 and 25, got ${windowedCount}`);

  const fullHtml = renderToStaticMarkup(createElement(CaptionTrackLane, laneProps));
  const fullCount = (fullHtml.match(/class="cc-caption-track-cue/g) ?? []).length;
  assert.equal(fullCount, 1000, 'omitting visibleWindow still renders all cues for callers without windowing');
  console.log(`captionPerformance.verify: manual1k=${manualColdMs.toFixed(1)}ms, asr3k=${asrColdMs.toFixed(1)}ms, save=${saveMs.toFixed(1)}ms, windowedCues=${windowedCount}/1000 OK`);
} finally {
  await server.close();
}
