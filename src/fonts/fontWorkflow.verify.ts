import assert from 'node:assert/strict';
import { captionFontPatch, captionFontKey, captionSelectedFontsPatch } from './captionFontScope';
import { filterFontEntries, fontPickerEntries, nextFontRecent } from './fontPickerModel';
import { assetFontFamily, fontAssetMetadata } from '../../shared/desktop-fonts';
import { buildCues } from '../captions/captionCues';
import { buildCaptionPages } from '../captions/captionPages';
import { findCaptionPreviewTarget } from '../captions/captionPreviewTarget';
import { captionTypographyStyle } from '../captions/renderStyles';
import { collectReferencedFontAssetIds } from './projectFonts';
import { timelineReadinessKey } from '../editor/timelineReadinessKey';
import { resolveTextStyle } from '../editor/textStyles';
import { collectExportMediaPlan } from '../export/exportMediaPlan';
import { collectUploadSrcs } from '../persist/projectTransfer';
import { migrateProjectDoc } from '../persist/projectStore';
import { docFromTimeline } from '../persist/projectStore';
import type { CaptionsData } from '../captions/types';
import type { MediaAsset, TimelineState } from '../editor/types';
import { ensureReferencedAssetFont } from './assetFonts';
import { isMediaAsset } from '../persist/migrations/normalize';

const asset: MediaAsset = { id: 'font_exact', kind: 'file', name: '自选字体', src: '/media/uploads/exact.ttf', durationInFrames: 0,
  props: { resourceType: 'font', font: { family: '自选字体', fullName: '自选字体 Regular', postscriptName: 'ExactFont',
    subfamily: 'Regular', weight: 400, style: 'normal', faceIndex: 0, source: 'imported', format: 'truetype' } } };
const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', styleOverride: { fontFamily: 'Noto Sans SC', fontSize: .052, strokeWidth: 5, color: '#ffffff' },
  sourceEntries: [{ id: 'lane_1', itemId: 'manual:lane_1', style: { color: '#ff0000', fontWeight: 800 }, words: [
    { id: 'cue_1', start: 0, end: 1000, text: '第一句' }, { id: 'cue_2', start: 1000, end: 2000, text: '第二句' },
  ] }] };
const target = findCaptionPreviewTarget(captions, [], 30, 500)!;
const choice = { fontFamily: '自选字体', fontAssetId: asset.id };
const secondTarget = findCaptionPreviewTarget(captions, [], 30, 1500)!;
const multiPatch = captionSelectedFontsPatch(captions, choice, [target, secondTarget]);
assert.deepEqual(Object.keys(multiPatch), ['cueFonts'], 'one multi-cue patch changes only font overrides');
const multiCaptions = { ...captions, ...multiPatch };
assert.equal(findCaptionPreviewTarget(multiCaptions, [], 30, 500)?.preset.fontAssetId, asset.id);
assert.equal(findCaptionPreviewTarget(multiCaptions, [], 30, 1500)?.preset.fontAssetId, asset.id);
assert.equal(multiCaptions.styleOverride, captions.styleOverride);
assert.equal(multiCaptions.sourceEntries, captions.sourceEntries);
assert.equal(multiCaptions.sourceEntries?.[0]?.style?.color, '#ff0000');
assert.throws(() => captionSelectedFontsPatch(captions, choice, []), /选中/);
const selected = { ...captions, ...captionFontPatch(captions, choice, 'selected', target) };
const cues = buildCues(selected, [], 30);
assert.equal(cues[0]?.fontOverride?.fontAssetId, asset.id); assert.equal(cues[1]?.fontOverride, undefined);
assert.equal(findCaptionPreviewTarget(selected, [], 30, 500)?.preset.fontAssetId, asset.id);
assert.equal(findCaptionPreviewTarget(selected, [], 30, 1500)?.preset.fontAssetId, undefined);
assert.equal(selected.styleOverride?.fontSize, .052); assert.equal(selected.styleOverride?.strokeWidth, 5);
assert.equal(selected.sourceEntries?.[0]?.style?.color, '#ff0000');
assert.equal(captionTypographyStyle(findCaptionPreviewTarget(selected, [], 30, 500)!.preset, 1080).fontFamily,
  `${assetFontFamily(asset.id)}, system-ui, sans-serif`);
const all = { ...selected, ...captionFontPatch(selected, choice, 'track') };
assert.equal(all.cueFonts, undefined); assert.equal(all.sourceEntries?.[0]?.style?.color, '#ff0000');
assert.equal(all.styleOverride?.fontAssetId, asset.id); assert.equal(all.styleOverride?.strokeWidth, 5);
const bundledCue = { ...all, ...captionFontPatch(all, { fontFamily: 'Smiley Sans' }, 'selected', target) };
const bundledRoundTrip: CaptionsData = JSON.parse(JSON.stringify(bundledCue));
assert.equal(findCaptionPreviewTarget(bundledRoundTrip, [], 30, 500)?.preset.fontAssetId, null,
  'a selected bundled font must clear the inherited file font even after saving');
assert.equal(findCaptionPreviewTarget(bundledRoundTrip, [], 30, 1500)?.preset.fontAssetId, asset.id);
assert.equal(resolveTextStyle({ text: '标题', fontFamily: 'Noto Sans SC' }).fontFamily, 'Noto Sans SC');
assert.equal(resolveTextStyle({ fontFamily: '自选字体', fontAssetId: asset.id }).fontFamily, assetFontFamily(asset.id));
assert.equal(fontAssetMetadata(asset)?.fullName, '自选字体 Regular');
assert.equal(isMediaAsset(asset), true, 'non-temporal font file resources must persist with zero timeline duration');
assert.equal(isMediaAsset({ ...asset, props: undefined }), false, 'the zero-duration exception is only for valid font resources');
const state: TimelineState = { fps: 30, width: 1920, height: 1080, items: [{ id: 'text1', kind: 'text', name: '标题', track: 'video', startFrame: 0, durationInFrames: 60,
  props: { text: '标题', ...choice } }], selectedId: null, assets: [asset], captions: selected };
assert.deepEqual(collectReferencedFontAssetIds(state), [asset.id]);
assert.ok(collectExportMediaPlan(state).references.some((reference) => reference.assetId === asset.id));
assert.ok(collectExportMediaPlan({ ...state, assets: [] }).issues.some((issue) => issue.code === 'missing_reference' && issue.assetId === asset.id));
await assert.rejects(ensureReferencedAssetFont(asset.id, []), /缺少字体/);
assert.notEqual(timelineReadinessKey(state), timelineReadinessKey({ ...state, items: state.items.map((item) => ({ ...item, props: { ...item.props, fontAssetId: 'another' } })) }));
const doc = docFromTimeline(state), reloaded = migrateProjectDoc(JSON.parse(JSON.stringify(doc)))!;
assert.equal(reloaded.assets[0]?.props?.resourceType, 'font');
assert.equal(reloaded.timelines[0]?.items[0]?.props?.fontAssetId, asset.id);
assert.deepEqual(collectUploadSrcs(doc), [asset.src]);
assert.equal(buildCaptionPages(reloaded.timelines[0]!.captions!, reloaded.timelines[0]!.items, 30)[0]?.fontOverride?.fontAssetId, asset.id);
const entries = fontPickerEntries([asset], []);
assert.equal(filterFontEntries(entries, 'imported', '自选', [], [])[0]?.asset?.id, asset.id);
assert.ok(filterFontEntries(entries, 'bundled', '思源', [], []).some((entry) => entry.family === 'Noto Sans SC'));
assert.equal(filterFontEntries(entries, 'favorite', '', [`asset:${asset.id}`], [])[0]?.asset?.id, asset.id);
assert.deepEqual(nextFontRecent(['a', 'b'], 'b'), ['b', 'a']);
assert.equal(captionFontKey('cue_1', undefined), 'cue:cue_1');

// A corrected/split ASR display part keeps its own font identity.
const sourceItem: TimelineState['items'][number] = { id: 'font-source', name: 'source', kind: 'video',
  track: 'V1', startFrame: 0, srcInFrame: 0, durationInFrames: 60, transcriptGenerationId: 'font-generation',
  transcript: [{ id: 'font-word-a', text: 'Alpha', start: 0, end: 1000 }, { id: 'font-word-b', text: 'Beta', start: 1000, end: 2000 }] };
const sourceCaptions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase',
  styleOverride: { color: '#ffffff', strokeWidth: 5 }, sourceEntries: [{ id: 'font-source-lane', itemId: sourceItem.id }] };
const unedited = buildCues(sourceCaptions, [sourceItem], 30);
const sourceSpans = unedited.flatMap(row => row.sourceSpans ?? []);
assert.equal(sourceSpans.length, 2);
const editedCaptions: CaptionsData = { ...sourceCaptions, sourceEntries: [{ ...sourceCaptions.sourceEntries![0]!,
  displayCueEdits: [{ id: 'font-display-edit', coveredWordRefs: sourceSpans.map(span=>span.wordRef), parts: [
    { id: 'font-part-left', text: 'Left', sourceSpans: [sourceSpans[0]!] },
    { id: 'font-part-right', text: 'Right', sourceSpans: [sourceSpans[1]!] },
  ] }] }] };
const editedTarget = findCaptionPreviewTarget(editedCaptions, [sourceItem], 30, 500)!;
const editedFont = { ...editedCaptions, ...captionFontPatch(editedCaptions, choice, 'selected', editedTarget) };
const editedRows = buildCues(JSON.parse(JSON.stringify(editedFont)), [sourceItem], 30);
assert.equal(editedRows.length, 2);
assert.equal(editedRows[0]?.fontOverride?.fontAssetId, asset.id, 'Selected display part reads the font written by its selection');
assert.equal(editedRows[1]?.fontOverride, undefined, 'Changing one display part must not change its sibling');
assert.deepEqual(editedFont.styleOverride, editedCaptions.styleOverride, 'Font changes preserve white text and stroke');
console.log('fontWorkflow.verify: independent font/scope, preview identity, persistence, media/export references and picker search passed');
