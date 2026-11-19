import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { buildCommands } from './storeCommandBuilder';
import { historyReduce, type History } from './reducerHistory';
import { activeTimeline, type MediaAsset, type ProjectDoc } from './types';
import { sourceFrameAt } from './sourceLimit';
import { placeMediaAssets } from './mediaAssetPlacement';
import { isMediaSourceRange, resolveMediaSourceRange, sourceRangeFromMap } from './mediaSourceRange';
import { EDITOR_DRAG_MIME, mediaAssetIds, mediaSourceRangeFor, parseEditorDrag } from './editorDrag';
import { parseMediaAssetDrop, setMediaAssetDrag } from '../media/drag';

const a: MediaAsset = { id: 'a', name: 'long.mp4', kind: 'video', src: '/original/long.mp4', durationInFrames: 36000 };
const b: MediaAsset = { ...a, id: 'b', src: '/original/b.mp4', durationInFrames: 600 };
const rangeA = { srcInFrame: 3000, durationInFrames: 150 };
const rangeB = { srcInFrame: 590, durationInFrames: 100 };
assert.equal(resolveMediaSourceRange(a), undefined, 'unmarked assets preserve whole-source default');
assert.deepEqual(resolveMediaSourceRange(a, rangeA), rangeA);
assert.deepEqual(resolveMediaSourceRange(b, rangeB), { srcInFrame: 590, durationInFrames: 10 });
assert.deepEqual(resolveMediaSourceRange(b, { srcInFrame: 599 }), { srcInFrame: 599, durationInFrames: 1 });
for (const bad of [{ srcInFrame: NaN }, { srcInFrame: Infinity }, { srcInFrame: 600 }, { durationInFrames: 0 }, { durationInFrames: -1 }, { durationInFrames: NaN }]) {
  assert.throws(() => resolveMediaSourceRange(b, bad));
}
for (const bad of [null, {}, { srcInFrame: -1, durationInFrames: 10 }, { srcInFrame: 1.5, durationInFrames: 10 }, { srcInFrame: 0, durationInFrames: Infinity }]) assert.equal(isMediaSourceRange(bad), false);
assert.equal(sourceRangeFromMap({}, 'toString'), undefined);

const original: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION, assets: [a, b], mediaFolders: [], activeTimelineId: 'main',
  timelines: [{ id: 'main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080,
    items: [], selectedId: null, tracks: { main: { kind: 'video' }, overlay: { kind: 'video' } },
    trackOrder: ['overlay', 'main'], interaction: { mainTrackId: 'main', magnet: true, linkage: true } }],
};
let history: History = { past: [], present: original, future: [] };
const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
commands.beginHistoryGesture();
placeMediaAssets({ assetIds: ['a', 'b'], assets: [a, b], startFrame: 0,
  sourceRangeFor: (asset) => asset.id === 'a' ? rangeA : rangeB,
  add: (asset, startFrame, range) => commands.addMediaItem(asset, { track: 'main', startFrame, ...range }),
  select: commands.selectItems,
});
commands.endHistoryGesture();
const items = activeTimeline(history.present).items;
assert.deepEqual(items.map((item) => [item.sourceAssetId, item.startFrame, item.srcInFrame, item.durationInFrames]), [
  ['a', 0, 3000, 150], ['b', 150, 590, 10],
]);
assert.equal(sourceFrameAt(items[0]!, 149), 3149, 'selected last frame maps to the original source');
assert.equal(sourceFrameAt(items[1]!, 9), 599);
assert.equal(history.past.length, 1, 'multi-asset selected ranges remain one undo action');
assert.deepEqual(history.present.assets, [a, b], 'range selection never changes asset duration or original URL');
const reopened = JSON.parse(JSON.stringify(history.present)) as ProjectDoc;
assert.deepEqual(activeTimeline(reopened).items, JSON.parse(JSON.stringify(items)), 'normal project JSON retains every serializable clip field, including source offsets and lengths');
commands.undo();
assert.deepEqual(history.present, original);
commands.redo();
assert.deepEqual(activeTimeline(history.present).items, items);

const overlayId = commands.addMediaItem(a, { track: 'overlay', startFrame: 5, ...rangeA });
const overlay = activeTimeline(history.present).items.find((item) => item.id === overlayId)!;
assert.equal(overlay.track, 'overlay');
assert.equal(overlay.startFrame, 5);
assert.equal(overlay.mainClipId, items[0]!.id);
assert.equal(overlay.srcInFrame, 3000);
commands.undo();
const prior = history;
assert.throws(() => placeMediaAssets({ assetIds: ['a', 'b'], assets: [a, b], startFrame: 0,
  sourceRangeFor: (asset) => asset.id === 'a' ? rangeA : { srcInFrame: 9999, durationInFrames: 10 },
  add: (asset, startFrame, range) => commands.addMediaItem(asset, { startFrame, ...range }), select: commands.selectItems,
}));
assert.equal(history, prior, 'a stale second range does not insert the first asset or consume redo');
assert.throws(() => commands.addMediaItem({ ...b, kind: 'audio' }, { srcInFrame: 600 }), /入点/);
assert.equal(history, prior, 'invalid range cannot create a new audio lane');
const wholeId = commands.addMediaItem(b, { track: 'overlay', startFrame: 0 });
const whole = activeTimeline(history.present).items.find((item) => item.id === wholeId)!;
assert.equal(whole.durationInFrames, 600);
assert.equal(whole.srcInFrame ?? 0, 0);

const spoken: MediaAsset = { ...a, id: 'spoken', kind: 'audio', transcript: [{ text: 'word after silence', start: 5000, end: 9000 }] };
const selectedAudioId = commands.addMediaItem(spoken, { srcInFrame: 30, durationInFrames: 300, startFrame: 0 });
const selectedAudio = activeTimeline(history.present).items.find((item) => item.id === selectedAudioId)!;
assert.equal(selectedAudio.transcript, undefined, 'explicit audio source selection must not switch to trimmed/repacked word-stream time');
assert.equal(selectedAudio.srcInFrame, 30);
assert.equal(selectedAudio.durationInFrames, 300);
assert.equal(sourceFrameAt(selectedAudio, 0), 30, 'audio selection includes the selected leading silence');
assert.equal(spoken.transcript![0]!.start, 5000, 'pool transcript is retained unchanged');
const defaultAudioId = commands.addMediaItem(spoken, { startFrame: 300 });
assert.deepEqual(activeTimeline(history.present).items.find((item) => item.id === defaultAudioId)!.transcript, spoken.transcript, 'ordinary whole-audio import retains previous behavior');

class Transfer {
  values = new Map<string, string>();
  effectAllowed = 'uninitialized';
  get types() { return [...this.values.keys()]; }
  setData(key: string, value: string) { this.values.set(key, value); }
  getData(key: string) { return this.values.get(key) ?? ''; }
}
const transfer = new Transfer();
const event = { dataTransfer: transfer } as unknown as React.DragEvent;
setMediaAssetDrag(event, a, ['a', 'b'], 'bgm', { a: rangeA, b: rangeB });
const payload = parseEditorDrag(event);
assert.ok(payload?.source === 'media');
assert.deepEqual(mediaAssetIds(payload), ['a', 'b']);
assert.deepEqual(mediaSourceRangeFor(payload, 'a'), rangeA);
assert.deepEqual(mediaSourceRangeFor(payload, 'b'), rangeB);
assert.equal(mediaSourceRangeFor(payload, 'other'), undefined);
assert.deepEqual(parseMediaAssetDrop(event)?.sourceRange, rangeA, 'legacy lane-drop MIME also carries the range');
for (const patch of [{ sourceRange: { srcInFrame: -1, durationInFrames: 3 } }, { sourceRanges: { b: { srcInFrame: 0, durationInFrames: 0 } } }]) {
  transfer.setData(EDITOR_DRAG_MIME, JSON.stringify({ ...payload, ...patch }));
  assert.equal(parseEditorDrag(event), null, 'malformed source ranges fail before any timeline mutation');
}
console.log('mediaSourceRange.verify: original bounds, real commands/history, batch ordering and both drag formats passed');
