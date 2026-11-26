import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import type { MediaAsset, ProjectDoc, TimelineItem, TimelineState, TransitionItem } from '../../editor/types';
import { resolvePreviewRenderProject, resolveSelectedPreviewTargetId } from './previewRenderProject';

const baseClip = (id: string, extra: Partial<TimelineItem> = {}): TimelineItem => ({
  id,
  name: id,
  kind: 'video',
  track: 'V1',
  startFrame: 0,
  durationInFrames: 90,
  src: '/media/uploads/a.mp4',
  ...extra,
});

const sharedAssets: MediaAsset[] = [];

const timelineState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  selectedIds: [],
  trackOrder: ['V1'],
  tracks: { V1: { kind: 'video' } },
  items: [baseClip('a'), baseClip('b', { startFrame: 90 })],
  transitions: [],
  assets: sharedAssets,
};

const project: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  activeTimelineId: 'tl-1',
  assets: sharedAssets,
  mediaFolders: [],
  timelines: [
    {
      ...timelineState,
      id: 'tl-1',
      name: 'Main',
      order: 0,
    },
  ],
};

// 1. Selection-only changes return the exact same ProjectDoc reference.
{
  const selectedOnlyState: TimelineState = {
    ...timelineState,
    selectedId: 'a',
    selectedIds: ['a'],
  };
  const resolved = resolvePreviewRenderProject(project, 'tl-1', selectedOnlyState);
  assert.equal(resolved, project, 'selection-only state update must preserve ProjectDoc reference');
}

// 2. Render-relevant changes (e.g. live items/captions) return a fresh ProjectDoc with transient selection stripped.
{
  const liveItems = [baseClip('a', { filters: { brightness: 1.2 } }), baseClip('b', { startFrame: 90 })];
  const previewState: TimelineState = {
    ...timelineState,
    selectedId: 'a',
    selectedIds: ['a'],
    items: liveItems,
  };
  const resolved = resolvePreviewRenderProject(project, 'tl-1', previewState);
  assert.notEqual(resolved, project);
  assert.equal(resolved.timelines[0]?.items, liveItems);
  assert.equal(resolved.timelines[0]?.selectedId, null);
  assert.equal(resolved.timelines[0]?.selectedIds, undefined);
}

// 3. Plain selected clips do not become GL preview targets; effects and enabled incoming transitions do.
{
  const plain = baseClip('plain');
  const fx = baseClip('fx', { effects: [{ id: 'fx1', assetId: 'builtin:fx-blur', overrides: {} }] });
  const incoming = baseClip('inc', { startFrame: 90 });
  const enabledTransition: TransitionItem = {
    id: 'tr1',
    trackId: 'V1',
    type: 'cross-dissolve',
    outgoingItemId: 'plain',
    incomingItemId: 'inc',
    durationInFrames: 15,
  };
  const disabledTransition: TransitionItem = { ...enabledTransition, enabled: false };

  assert.equal(resolveSelectedPreviewTargetId(null, [enabledTransition]), undefined);
  assert.equal(resolveSelectedPreviewTargetId(plain, [enabledTransition]), undefined);
  assert.equal(resolveSelectedPreviewTargetId(fx, []), 'fx');
  assert.equal(resolveSelectedPreviewTargetId(incoming, [enabledTransition]), 'inc');
  assert.equal(resolveSelectedPreviewTargetId(incoming, [disabledTransition]), undefined);
}

console.log('previewRenderProject.verify: ok (选中引用稳定/预览改动透传/特效转场目标识别)');
