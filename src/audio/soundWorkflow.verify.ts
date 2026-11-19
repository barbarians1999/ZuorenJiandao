import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from '../editor/reduce';
import { buildCommands } from '../editor/storeCommandBuilder';
import { activeEditorState, type ProjectDoc, type TrackFlags } from '../editor/types';
import { SOUND_EFFECTS } from './soundLibrary';
import { planSoundPlacement, placeSound, soundAssetForId } from './soundPlacement';
import { filterSoundResults, matchesSoundQuery, SOUND_FILTERS } from './soundResults';
import { normalizeSoundCollections, readSoundCollections, writeSoundCollections } from './soundCollections';

function fixture(audio: TrackFlags = { kind: 'audio' }): ProjectDoc {
  return { version: CURRENT_PROJECT_VERSION, activeTimelineId: 'main', assets: [], mediaFolders: [], timelines: [{
    id: 'main', name: 'main', order: 0, fps: 30, width: 1920, height: 1080, selectedId: null,
    items: [], tracks: { V1: { kind: 'video' }, A1: audio }, trackOrder: ['V1', 'A1'],
  }] };
}
function harness(initial: ProjectDoc) {
  let history: History = { past: [], present: initial, future: [] };
  let selectedId: string | null = null;
  const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present,
    (action) => { if (action.type === 'select') selectedId = action.id; });
  const errors: string[] = [];
  return { commands, errors, get: () => history, selected: () => selectedId, add: (at: { startFrame: number; track?: string; newTrack?: boolean }) =>
    placeSound(activeEditorState(history.present), commands, soundAssetForId('simple-whoosh', 30)!, at, (message) => errors.push(message)) };
}

{
  const initial = fixture();
  const h = harness(initial);
  assert.equal(h.add({ startFrame: 300 }), true);
  const clip = h.get().present.timelines[0].items[0];
  assert.equal(clip.startFrame, 300, 'button placement uses the playhead, not the audio lane end');
  assert.equal(clip.track, 'A1');
  assert.equal(h.selected(), clip.id, 'new clip is selected through the production transient-selection channel');
  assert.equal(h.get().past.length, 1);
  h.commands.undo();
  assert.deepEqual(h.get().present, initial, 'one undo removes the audio and registered source');
  h.commands.redo();
  assert.equal(h.get().present.timelines[0].items[0].startFrame, 300);
}
for (const flags of [{ kind: 'audio', role: 'follower' }, { kind: 'audio', role: 'anchor' }, { kind: 'audio', muted: true }] as const) {
  const initial = fixture(flags);
  const h = harness(initial);
  assert.equal(h.add({ startFrame: 75 }), true);
  const timeline = h.get().present.timelines[0];
  const clip = timeline.items[0];
  assert.notEqual(clip.track, 'A1', 'sound does not become ducked music, speech, or muted audio');
  assert.equal(timeline.tracks?.[clip.track]?.role, undefined);
  assert.equal(clip.startFrame, 75);
  assert.equal(h.get().past.length, 1, 'track, source and clip share one undo step');
  h.commands.undo();
  assert.deepEqual(h.get().present, initial);
}
{
  const initial = fixture();
  initial.timelines[0].items = [{ id: 'existing', kind: 'audio', name: 'existing', track: 'A1', startFrame: 260, durationInFrames: 100 }];
  const h = harness(initial);
  assert.equal(h.add({ startFrame: 300, track: 'A1' }), true);
  const [original, added] = h.get().present.timelines[0].items;
  assert.deepEqual(original, initial.timelines[0].items[0], 'sound never overwrites or ripples existing audio');
  assert.notEqual(added.track, 'A1');
  assert.equal(added.startFrame, 300, 'occupied lane does not shift the editorial moment');
  assert.equal(h.get().past.length, 1);
  h.commands.undo();
  assert.deepEqual(h.get().present, initial);
}
{
  const initial = fixture({ kind: 'audio', locked: true });
  const h = harness(initial);
  assert.equal(h.add({ startFrame: 75, track: 'A1' }), false);
  assert.match(h.errors[0], /锁定/);
  assert.equal(h.get().past.length, 0);
  assert.deepEqual(h.get().present, initial, 'locked explicit drop neither adds nor creates a lane');
  assert.equal(h.add({ startFrame: 75 }), true, 'automatic button placement avoids a locked lane');
}
{
  const h = harness(fixture());
  assert.equal(h.add({ startFrame: 31.7, newTrack: true }), true);
  assert.equal(h.get().present.timelines[0].items[0].startFrame, 32);
  assert.notEqual(h.get().present.timelines[0].items[0].track, 'A1', 'new-track drop explicitly creates a lane');
  assert.equal(h.get().past.length, 1);
  assert.equal(h.add({ startFrame: Number.NaN }), false);
  assert.equal(h.get().past.length, 1, 'invalid request does not add undo history');
}
assert.equal(planSoundPlacement(activeEditorState(fixture()), 0, { startFrame: 0 }).ok, false);
assert.equal(soundAssetForId('unknown', 30), null);
assert.equal(soundAssetForId('simple-whoosh', 0), null);
assert.equal(soundAssetForId('simple-whoosh', 30)?.src, '/sound-effects/simple-whoosh.mp3');

const empty = { favorites: [], recent: [] };
const nonPopular = SOUND_EFFECTS.find((sound) => !sound.popular)!;
assert.deepEqual(filterSoundResults([nonPopular], SOUND_FILTERS.all, empty), [nonPopular], 'all search results include non-popular assets');
assert.equal(filterSoundResults([nonPopular], SOUND_FILTERS.popular, empty).length, 0);
assert(matchesSoundQuery(nonPopular, nonPopular.name.toUpperCase()));
assert(matchesSoundQuery(SOUND_EFFECTS.find((sound) => sound.id === 'mouse-click')!, '鼠标'));
assert(matchesSoundQuery(nonPopular, '我的本机中文名', '我的本机中文名'), 'localized names participate in search');
assert(!matchesSoundQuery(nonPopular, 'no-such-sound-9834'));
const first = SOUND_EFFECTS[0], second = SOUND_EFFECTS[1];
const collections = { favorites: [second.id], recent: [second.id, first.id] };
assert.deepEqual(filterSoundResults([first, second], SOUND_FILTERS.favorites, collections), [second]);
assert.deepEqual(filterSoundResults([first, second], SOUND_FILTERS.recent, collections), [second, first]);
assert.deepEqual(normalizeSoundCollections({ favorites: [first.id, first.id, 'missing', null], recent: [second.id, 'missing'] }),
  { favorites: [first.id], recent: [second.id] });
let stored = '';
const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
assert(writeSoundCollections(collections, storage));
assert.deepEqual(readSoundCollections(storage), collections, 'favorite/recent data survives a new read');
const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
assert.equal(writeSoundCollections(collections, denied), false);
assert.deepEqual(readSoundCollections(denied), collections, 'storage failures retain the current session choices');

let bytes = 0;
for (const sound of SOUND_EFFECTS) {
  const file = await stat(new URL(`../../assets/sound-effects/${sound.id}.mp3`, import.meta.url));
  assert(file.isFile() && file.size > 0, `bundled audio must exist: ${sound.id}`);
  bytes += file.size;
}
assert(bytes < 10 * 1024 * 1024, 'built-in sound library stays lightweight and offline');
console.log(`soundWorkflow.verify: playhead/drop placement, ordinary lanes, lock notices, one-step undo, collections/search, ${SOUND_EFFECTS.length} local assets (${bytes} bytes)`);
