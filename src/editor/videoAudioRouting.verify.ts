import assert from 'node:assert/strict';
import { usesVideoAudioRenderer } from './videoAudioRouting';
import type { TimelineItem } from './types';
import { audioPlaybackWindows } from './audioPlaybackWindow';

const video: TimelineItem = {
  id: 'v', track: 'V1', kind: 'video', name: 'source', src: '/media/asset.mp4', sourceAssetId: 'asset-1',
  startFrame: 30, durationInFrames: 60, srcInFrame: 45, playbackRate: 1.5, volume: 0, audioDetached: true,
};
const detached: TimelineItem = {
  ...video, id: 'a', track: 'A1', kind: 'audio', audioDetached: true,
};
const legacyDetached: TimelineItem = { ...detached, audioDetached: undefined, startFrame: 300 };
const ordinaryAudio: TimelineItem = {
  ...detached, id: 'ordinary', src: '/media/music.mp3', sourceAssetId: 'music-1', audioDetached: undefined,
};

assert.equal(usesVideoAudioRenderer(detached), true, 'new detached clips carry an explicit video-audio marker');
assert.equal(usesVideoAudioRenderer(legacyDetached, [video]), true, 'legacy pair is identified after moving the audio clip');
assert.equal(usesVideoAudioRenderer(ordinaryAudio, [video]), false, 'ordinary audio stays on its previous route');
assert.equal(usesVideoAudioRenderer({ ...legacyDetached, playbackRate: 2 }, [video]), false, 'legacy match requires equal speed');
assert.equal(usesVideoAudioRenderer({ ...legacyDetached, srcInFrame: 46 }, [video]), false, 'legacy match requires equal source range');
assert.equal(usesVideoAudioRenderer({ ...legacyDetached, sourceAssetId: 'other-asset' }, [video]), false, 'legacy match requires the same stable asset');
assert.equal(usesVideoAudioRenderer(legacyDetached, [video, { ...video, id: 'v2', track: 'V2' }]), false,
  'ambiguous legacy pairs are not guessed');
assert.equal(usesVideoAudioRenderer(video), true, 'video audio rendered separately uses the video renderer path');
assert.equal(usesVideoAudioRenderer({ ...ordinaryAudio, kind: 'image' }), false);
const clips: TimelineItem[] = Array.from({length:200},(_,index)=>({
  id:`a${index}`,track:'A1',kind:'audio',name:'source',src:'/voice.wav',startFrame:index*90,durationInFrames:90,srcInFrame:index*90,
}));
const windows=audioPlaybackWindows(clips,clips,[],[],30,30);
const at=(frame:number)=>windows.filter(window=>frame>=window.from&&frame<window.to).map(window=>window.item.id);
assert.deepEqual(at(58),['a0']);
assert.deepEqual(at(60),['a0','a1'],'the incoming clip is mounted for its full one-second premount');
assert.deepEqual(at(90),['a1'],'outgoing audio is removed at its exclusive end');
assert.deepEqual(at(15000),['a166','a167'],'distant seeks immediately mount the destination and incoming clip only');
const transition={id:'tr',type:'audio-cross-fade' as const,trackId:'A1',outgoingItemId:'a0',incomingItemId:'a1',durationInFrames:30};
const extended=audioPlaybackWindows(clips.slice(0,2),clips,[{id:'voice',name:'voice',kind:'audio',src:'/voice.wav',durationInFrames:18000}],[transition],30,30);
assert.equal(extended[0].to,105,'crossfade tails remain mounted');
assert.equal(extended[1].from,45,'crossfade head plus premount remains mounted');
const edited:TimelineItem={...clips[0],id:'edited',startFrame:900,durationInFrames:60,deletedWordIdx:[1],
  transcript:[{text:'one',start:0,end:1000},{text:'two',start:1000,end:2000},{text:'three',start:2000,end:3000}]};
assert.deepEqual(audioPlaybackWindows([edited],[edited],[],[],30,30).map(w=>[w.from,w.to]),[[870,960]],'word deletion follows the existing edited sequence timing');
assert.equal(audioPlaybackWindows([{...edited,deletedWordIdx:[0,1,2]}],[edited],[],[],30,30).length,0,'fully removed speech never mounts audio');
console.log('videoAudioRouting.verify: passed');
