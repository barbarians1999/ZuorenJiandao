import assert from 'node:assert/strict';
import { CHAPTER_TEMPLATES } from './chapterTemplates';
import { TEMPLATES } from '../editor/initial';
import { prepareTemplate, validateTemplate } from '../template-host';
import { buildCommands } from '../editor/storeCommandBuilder';
import { historyReduce, type History } from '../editor/reduce';
import { createProject, docFromTimeline, flushProjectSaves, loadProject, resetProjectStoreMemory, saveProject } from '../persist/projectStore';

assert.equal(CHAPTER_TEMPLATES.length, 8);
assert.equal(new Set(TEMPLATES.map((template) => template.id)).size, TEMPLATES.length);
let history: History = { past: [], present: docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null }), future: [] };
const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);
for (const template of CHAPTER_TEMPLATES) {
  assert.ok(TEMPLATES.includes(template));
  assert.ok(template.thumb?.startsWith('data:image/svg+xml'));
  assert.ok(template.propSchema.some((field) => field.key === 'title' && field.type === 'text'));
  validateTemplate(template.code);
  await prepareTemplate(template.code); // actual Babel compilation through the normal sandbox
  commands.addMotionGraphic(template);
  const timeline = history.present.timelines[0];
  const item = timeline.items.at(-1)!;
  assert.equal(item.templateId, template.id);
  assert.deepEqual(item.props, template.props);
  history = historyReduce(history, { type: 'updateProps', id: item.id, patch: { title: '修改后的章节\n第二行', number: '02' } });
  assert.equal(history.present.timelines[0].items.at(-1)!.props!.title, '修改后的章节\n第二行');
}
const selected = history.present.timelines[0].items[0];
history = historyReduce(history, { type: 'updateProps', id: selected.id, patch: { visualEntrance: 'whip', visualExit: 'zoom', visualEntranceFrames: 14, visualExitFrames: 9 } });
const animated = history.present;
history = historyReduce(history, { type: 'undo' });
assert.equal(history.present.timelines[0].items[0].props!.visualEntrance, undefined);
history = historyReduce(history, { type: 'redo' });
assert.deepEqual(history.present, animated);
// Real save/load API with its isolated Node memory backend, never user projects.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 404 });
try {
  resetProjectStoreMemory();
  const meta = await createProject('chapter-regression', animated);
  await saveProject(meta.id, animated);
  await flushProjectSaves();
  const reopened = await loadProject(meta.id);
  assert.ok(reopened);
  assert.deepEqual(reopened.timelines[0].items.map((item) => item.props), animated.timelines[0].items.map((item) => item.props));
  assert.equal(reopened.timelines[0].items[0].code, selected.code);
} finally { resetProjectStoreMemory(); globalThis.fetch = originalFetch; }
console.log('chapterTemplates.verify: eight local cards compile, insert, edit, undo/redo, save and reopen OK');
