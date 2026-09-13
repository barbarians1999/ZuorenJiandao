import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { historyReduce, type History } from '../editor/reduce';
import { buildCommands } from '../editor/storeCommandBuilder';
import type { ProjectDoc, TimelineItem } from '../editor/types';
import { getMediaBlob, putMediaBlob, resetMediaBlobMemory } from './mediaBlobStore';
import {
  createProject,
  flushProjectSaves,
  loadChat,
  loadProject,
  migrateProjectDoc,
  resetProjectStoreMemory,
  saveChat,
  saveProject,
} from './projectStore';
import { buildProjectExport, importProjectPackage } from './projectTransfer';
import { listVersions, saveVersion } from './versionStore';

const sourceSrc = '/media/uploads/interview.mp4';
const sourceBytes = 'zuoren-roundtrip-media';
const originalFetch = globalThis.fetch;
const serverMedia = new Map<string, Blob>();
const serverOwners = new Map<string, string>();

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname.startsWith('/media/uploads/')) {
    const media = serverMedia.get(url.pathname);
    if (!media) return new Response(null, { status: 404 });
    return new Response((init?.method ?? 'GET') === 'HEAD' ? null : media, {
      headers: {
        'content-length': String(media.size),
        'content-type': media.type || 'application/octet-stream',
        'x-openchatcut-media-authority': 'server',
      },
    });
  }
  if (url.pathname === '/upload' && (init?.method ?? 'GET') === 'POST') {
    const assetId = url.searchParams.get('assetId') ?? 'fixture';
    const extension = url.searchParams.get('name')?.match(/(\.[A-Za-z0-9]+)$/)?.[1] ?? '.bin';
    const path = `/media/uploads/${assetId}${extension}`;
    if (serverMedia.has(path)) return Response.json({ path, created: false });
    assert.ok(init?.body instanceof Blob);
    serverMedia.set(path, init.body);
    const rollbackToken = url.searchParams.get('rollbackToken') ?? '';
    serverOwners.set(path, rollbackToken);
    return Response.json({ path, created: true, rollbackToken });
  }
  if (url.pathname === '/upload' && (init?.method ?? 'GET') === 'DELETE') {
    const path = `/media/uploads/${url.searchParams.get('name') ?? ''}`;
    if (serverOwners.get(path) === (url.searchParams.get('rollbackToken') ?? '')) {
      serverOwners.delete(path);
      serverMedia.delete(path);
    }
    return Response.json({ ok: true });
  }
  return new Response(null, { status: 404 });
};

function handoffDocument(): ProjectDoc {
  const item = (id: string, startFrame: number, durationInFrames: number, srcInFrame: number): TimelineItem => ({
    id,
    track: 'V1',
    startFrame,
    durationInFrames,
    srcInFrame,
    kind: 'video',
    name: `${id}.mp4`,
    src: sourceSrc,
  });
  return {
    version: CURRENT_PROJECT_VERSION,
    activeTimelineId: 'timeline-main',
    assets: [{
      id: 'asset-interview',
      name: 'interview.mp4',
      kind: 'video',
      src: sourceSrc,
      durationInFrames: 900,
    }],
    mediaFolders: [],
    timelines: [{
      id: 'timeline-main',
      name: '主时间线',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      tracks: { V1: { kind: 'video' } },
      trackOrder: ['V1'],
      items: [item('clip-a', 0, 300, 0), item('clip-b', 360, 300, 30)],
      selectedId: null,
    }],
  };
}

function editor(initial: ProjectDoc) {
  let history: History = { past: [], present: initial, future: [] };
  const commands = buildCommands(
    (action) => { history = historyReduce(history, action); },
    () => history.present,
  );
  return { commands, doc: () => history.present };
}

function item(doc: ProjectDoc, id: string): TimelineItem {
  const found = doc.timelines[0]?.items.find((candidate) => candidate.id === id);
  assert.ok(found, `missing timeline item: ${id}`);
  return found;
}

async function saveAndReload(projectId: string, doc: ProjectDoc): Promise<ProjectDoc> {
  const result = await saveProject(projectId, doc);
  assert.equal(result.saved, true);
  const flushed = await flushProjectSaves(projectId);
  assert.equal(flushed.ok, true);
  assert.equal(flushed.projects[0]?.ok, true);
  const reopened = await loadProject(projectId);
  assert.ok(reopened);
  return reopened;
}

resetProjectStoreMemory();
resetMediaBlobMemory();

const initial = migrateProjectDoc(handoffDocument());
assert.ok(initial);
const authorProject = await createProject('左人剪刀往返验收', initial);
assert.deepEqual(await loadProject(authorProject.id), initial, '保存并关闭后可从工程库重新打开同一时间线');
await putMediaBlob(sourceSrc, new Blob([sourceBytes], { type: 'video/mp4' }), {
  name: 'interview.mp4',
  mime: 'video/mp4',
});
await saveChat(authorProject.id, { messages: [{ role: 'user', text: '剪掉气口' }], llm: [] });
const named = await saveVersion(authorProject.id, '交接前', initial);

const author = editor(initial);
author.commands.batch([
  { type: 'move', id: 'clip-a', startFrame: 30 },
  { type: 'retime', id: 'clip-a', durationInFrames: 240, srcInFrame: 15 },
  { type: 'split', id: 'clip-b', atFrame: 480, newId: 'clip-b-tail' },
], 'Codex 批量调整');
const edited = structuredClone(author.doc());
assert.equal(item(edited, 'clip-a').startFrame, 30);
assert.equal(item(edited, 'clip-a').durationInFrames, 240);
assert.equal(item(edited, 'clip-a').srcInFrame, 15);
assert.equal(item(edited, 'clip-b').durationInFrames, 120);
assert.equal(item(edited, 'clip-b-tail').startFrame, 480);

author.commands.undo();
assert.deepEqual(author.doc(), initial, '一次撤销还原整组移动、裁切和分割');
author.commands.redo();
assert.deepEqual(author.doc(), edited, '一次重做恢复整组移动、裁切和分割');

author.commands.applyDoc(named.doc);
assert.deepEqual(author.doc(), initial, '命名版本恢复当前时间线');
author.commands.undo();
assert.deepEqual(author.doc(), edited, '版本恢复本身可用一次撤销回到恢复前');
author.commands.redo();
assert.deepEqual(author.doc(), initial, '版本恢复本身可重做');
author.commands.undo();
assert.deepEqual(author.doc(), edited);

assert.deepEqual(await saveAndReload(authorProject.id, author.doc()), edited);
const exportedToSecondEditor = await buildProjectExport(authorProject.id, authorProject.name);
assert.equal(exportedToSecondEditor.mediaTotal, 1);
assert.deepEqual(exportedToSecondEditor.mediaMissing, []);

resetProjectStoreMemory();
resetMediaBlobMemory();
const importedBySecondEditor = await importProjectPackage(exportedToSecondEditor.blob);
assert.notEqual(importedBySecondEditor.meta.id, authorProject.id, '导入明确创建新的本地工程 ID');
assert.deepEqual(await listVersions(importedBySecondEditor.meta.id), [], '命名版本是本机安全状态，不随工程包传递');
const secondDoc = await loadProject(importedBySecondEditor.meta.id);
assert.ok(secondDoc);
assert.equal(item(secondDoc, 'clip-a').startFrame, 30);
assert.equal(item(secondDoc, 'clip-a').durationInFrames, 240);
assert.equal(item(secondDoc, 'clip-b-tail').startFrame, 480);
assert.deepEqual(secondDoc.timelines[0]?.items.map((entry) => entry.id), edited.timelines[0]?.items.map((entry) => entry.id));
const importedSrc = secondDoc.assets[0]?.src;
assert.ok(importedSrc);
assert.equal(await (await getMediaBlob(importedSrc))?.blob.text(), sourceBytes, '换机导入恢复相同媒体内容');
assert.deepEqual((await loadChat(importedBySecondEditor.meta.id))?.messages, [{ role: 'user', text: '剪掉气口' }]);

const secondEditor = editor(secondDoc);
secondEditor.commands.setItemVolume('clip-a', 0.75);
const returnedDoc = structuredClone(secondEditor.doc());
await saveAndReload(importedBySecondEditor.meta.id, returnedDoc);
const exportedBack = await buildProjectExport(importedBySecondEditor.meta.id, importedBySecondEditor.meta.name);

resetProjectStoreMemory();
resetMediaBlobMemory();
const returnedToAuthor = await importProjectPackage(exportedBack.blob);
const finalDoc = await loadProject(returnedToAuthor.meta.id);
assert.ok(finalDoc);
assert.equal(item(finalDoc, 'clip-a').volume, 0.75, '返回包保留第二位编辑者的最新修改');
assert.equal(item(finalDoc, 'clip-b-tail').startFrame, 480, '返回包没有回退到初始时间线');
assert.equal(await (await getMediaBlob(finalDoc.assets[0]!.src))?.blob.text(), sourceBytes);

globalThis.fetch = originalFetch;
console.log('zuoren-project-roundtrip.verify: reopen, atomic edit, version restore, and two-editor transfer passed');
