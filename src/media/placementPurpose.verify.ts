import assert from 'node:assert/strict';
import {
  BACKGROUND_MUSIC_INITIAL_VOLUME,
  mediaPlacementVolume,
} from './placementPurpose';

assert.equal(mediaPlacementVolume('audio', 'bgm'), BACKGROUND_MUSIC_INITIAL_VOLUME);
assert.equal(mediaPlacementVolume('audio'), undefined, 'generic audio keeps its existing default');
assert.equal(mediaPlacementVolume('video', 'bgm'), undefined, 'BGM intent never lowers video audio');

console.log('placementPurpose.verify: BGM-only initial volume OK');
