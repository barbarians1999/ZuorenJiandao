import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [pool, menus, library, mediaIngest, ingestProps] = await Promise.all([
  readFile(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./MediaPoolMenus.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../library/LibraryPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./useEditorMediaIngest.ts', import.meta.url), 'utf8'),
  readFile(new URL('./MediaPoolIngestProps.ts', import.meta.url), 'utf8'),
]);

assert.match(pool, /extends MediaPoolIngestProps/, 'pool inherits the shared ingest contract');
assert.match(ingestProps, /onAddAssetsToTimeline\?/, 'the media pool exposes one batch timeline callback');
assert.match(pool, /addToTimeline: onAddAssetsToTimeline/, 'the panel forwards the batch callback to its extracted menu');
assert.match(menus, /context\.assets\.filter\(\(item\) => isTimelineMediaAssetKind\(item\.kind\)\)/, 'the context menu excludes project-only files');
assert.match(menus, /context\.addToTimeline\(timelineAssets\)/, 'the context menu forwards every timeline-compatible selection');
assert.match(library, /onAddMediaAssetsToTimeline/, 'the library forwards the batch callback');
assert.match(mediaIngest, /const addMediaAssetsToTimeline[\s\S]*?select: commands\.selectItems/, 'the editor selects every newly placed clip together');

console.log('media-pool-batch-timeline.verify: batch placement wiring OK');
