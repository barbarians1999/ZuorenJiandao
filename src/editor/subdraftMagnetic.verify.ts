import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { activeTimeline, type ProjectDoc, type Timeline, type TimelineItem } from './types';
import { planSubdraft } from './subdraft';
import { buildCommands } from './storeCommandBuilder';
import { historyReduce, type History } from './reducerHistory';
import { resolveTimelineRenderPlan } from './sequenceGraph';
import { sourceFrameAt } from './sourceLimit';
import { mainTrackId } from './magneticTimeline';
import { introducesTrackOverlap } from './trackCollision';

const clip = (id: string, startFrame: number, patch: Partial<TimelineItem> = {}): TimelineItem => ({
  id, name: id, kind: 'video', src: `/${id}.mp4`, track: 'V1', startFrame, durationInFrames: 30, srcInFrame: 90,
  transform: { scale: 1.2, x: 4 }, mask: { type: 'rectangle', x: 0, y: 0, width: 1, height: 1, feather: .03 },
  props: { visualEntrance: 'push-left' }, volume: .7, ...patch,
});
const base = (): ProjectDoc => ({
  version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'main', timelines: [{
    id: 'main', name: 'Main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null,
    trackOrder: ['V3', 'V2', 'V1', 'A1'], tracks: { V3: { kind: 'video' }, V2: { kind: 'video' }, V1: { kind: 'video' }, A1: { kind: 'audio' } },
    interaction: { mainTrackId: 'V1', magnet: true, linkage: true },
    items: [clip('a', 0), clip('b', 30), clip('c', 60),
      clip('title', 35, { kind: 'text', track: 'V2', durationInFrames: 10, mainClipId: 'b' }),
      clip('voice', 30, { kind: 'audio', track: 'A1', durationInFrames: 25 })],
  }],
});
let serial = 0;
const uid = (prefix: string) => `${prefix}-${++serial}`;
function plan(doc: ProjectDoc, ids: string[]) {
  const result = planSubdraft(doc, ids, uid);
  if (!result.ok) assert.fail(result.error);
  return { ...result, parent: activeTimeline(result.doc), child: result.doc.timelines.find((timeline) => timeline.id === result.timelineId)!,
    sequence: activeTimeline(result.doc).items.find((item) => item.id === result.itemId)! };
}

// Main replacement occupies the original contiguous range, not a new upper lane.
{
  const doc = base();
  const before = structuredClone(doc);
  const result = plan(doc, ['b', 'voice']);
  assert.equal(result.sequence.track, 'V1');
  assert.equal(result.sequence.startFrame, 30);
  assert.equal(result.sequence.durationInFrames, 30);
  assert.deepEqual(result.parent.trackOrder, activeTimeline(doc).trackOrder);
  assert.equal(result.parent.items.find((item) => item.id === 'title')?.mainClipId, result.itemId);
  assert.equal(result.child.interaction?.magnet, false);
  assert.equal(mainTrackId(result.child), 'V1');
  assert.equal(introducesTrackOverlap(activeTimeline(doc), result.parent), false);
  assert.equal(resolveTimelineRenderPlan(result.doc, 'main').durationInFrames, resolveTimelineRenderPlan(doc, 'main').durationInFrames);
  assert.deepEqual(doc, before, 'planner is pure');
  for (const childItem of result.child.items) {
    const original = activeTimeline(doc).items.find((item) => item.id === childItem.id)!;
    assert.deepEqual({ ...childItem, startFrame: original.startFrame }, original, 'styles, sound, source trim remain verbatim');
    for (let localFrame = 0; localFrame < original.durationInFrames; localFrame += 1) {
      const globalFrame = original.startFrame + localFrame;
      const nestedFrame = sourceFrameAt(result.sequence, globalFrame - result.sequence.startFrame);
      assert.equal(sourceFrameAt(childItem, nestedFrame - childItem.startFrame), sourceFrameAt(original, localFrame));
    }
  }
}

// A range spanning an unselected main clip cannot overwrite or hide it.
{
  const doc = base();
  const result = planSubdraft(doc, ['a', 'c'], uid);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /未选中的主轨/);
  const longVoice = base();
  activeTimeline(longVoice).items.find((item) => item.id === 'voice')!.durationInFrames = 70;
  assert.equal(planSubdraft(longVoice, ['b', 'voice'], uid).ok, false, 'long audio does not make a nested clip cover unselected video');
}

// Pure overlays keep their own visual lane. Explicit external parent binding is
// transferred to the composite, never left dangling inside its child timeline.
{
  const result = plan(base(), ['title']);
  assert.notEqual(result.sequence.track, 'V1');
  assert.equal(result.sequence.mainClipId, 'b');
  assert.equal(result.child.items[0]!.mainClipId, undefined);
  assert.equal(result.child.interaction?.mainTrackId, 'V2', 'missing parent main id falls back to actual child lane');
  assert.equal(result.child.interaction?.magnet, false);
  const internal = plan(base(), ['b', 'title']);
  assert.equal(internal.child.items.find((item) => item.id === 'title')!.mainClipId, 'b');
  assert.equal(internal.sequence.mainClipId, undefined);
  const mixed = base();
  activeTimeline(mixed).items.push(clip('other-title', 65, { kind: 'text', track: 'V2', durationInFrames: 10, mainClipId: 'c' }));
  assert.equal(planSubdraft(mixed, ['title', 'other-title'], uid).ok, false, 'different directional parents cannot be silently collapsed into one');
}

// Existing stacking, linked membership and lock restrictions remain enforced.
{
  const interleaved = base();
  activeTimeline(interleaved).items.push(clip('top', 35, { track: 'V3', durationInFrames: 10 }));
  const result = planSubdraft(interleaved, ['b', 'top'], uid);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /叠放/);
  const locked = base();
  activeTimeline(locked).tracks!.V1 = { kind: 'video', locked: true };
  assert.equal(planSubdraft(locked, ['b'], uid).ok, false);
}

// A whole-timeline composite carries original track rendering inside the child.
// The destination parent lane is neutral or it would mute/hide all child lanes.
{
  const doc = base();
  activeTimeline(doc).tracks!.V1 = { kind: 'video', muted: true, hidden: true };
  const partial = planSubdraft(doc, ['b', 'title'], uid);
  assert.equal(partial.ok, false);
  const result = plan(doc, activeTimeline(doc).items.map((item) => item.id));
  assert.equal(result.child.tracks?.V1?.muted, true);
  assert.equal(result.child.tracks?.V1?.hidden, true);
  assert.equal(result.parent.tracks?.V1?.muted, false);
  assert.equal(result.parent.tracks?.V1?.hidden, false);
  assert.equal(result.sequence.startFrame, 0);
  assert.equal(result.sequence.durationInFrames, 90);
}

// Production command, one history step, durable nested IDs and source timing.
{
  const original = base();
  let history: History = { past: [], present: original, future: [] };
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
  const created = commands.createSubdraft(['b', 'voice']);
  assert.equal(created.ok, true);
  assert.equal(history.past.length, 1);
  const reopened = JSON.parse(JSON.stringify(history.present)) as ProjectDoc;
  assert.equal(resolveTimelineRenderPlan(reopened, 'main').durationInFrames, 90);
  const sequence = activeTimeline(reopened).items.find((item) => item.kind === 'sequence')!;
  assert.equal(sequence.track, 'V1');
  assert.equal(activeTimeline(reopened).items.find((item) => item.id === 'title')?.mainClipId, sequence.id);
  commands.undo();
  assert.deepEqual(history.present, original);
  commands.redo();
  assert.equal(history.present.timelines.length, 2);
  commands.moveItem(sequence.id, { startFrame: 200 });
  const movedParent: Timeline = activeTimeline(history.present);
  assert.equal(movedParent.items.find((item) => item.id === 'title')!.startFrame, 65);
  assert.equal(movedParent.items.find((item) => item.id === sequence.id)!.startFrame, 60);
}

console.log('subdraft magnetic: main replacement, safe stacking, parent remap, child settings, source timing and atomic history OK');
