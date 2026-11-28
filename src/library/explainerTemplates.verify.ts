import assert from 'node:assert/strict';
import { computeScanFocusLayout, EXPLAINER_TEMPLATES } from './explainerTemplates';
import { TEMPLATES } from '../editor/initial';
import { prepareTemplate, validateTemplate } from '../template-host';
import { buildCommands } from '../editor/storeCommandBuilder';
import { historyReduce, type History } from '../editor/reduce';
import {
  createProject,
  docFromTimeline,
  flushProjectSaves,
  loadProject,
  resetProjectStoreMemory,
  saveProject,
} from '../persist/projectStore';

assert.equal(EXPLAINER_TEMPLATES.length, 5);
assert.equal(new Set(TEMPLATES.map((template) => template.id)).size, TEMPLATES.length);

const EXPECTED_IDS = [
  'zuoren-explainer-scan-focus',
  'zuoren-explainer-flow-steps',
  'zuoren-explainer-data-counter',
  'zuoren-explainer-quote-card',
  'zuoren-explainer-strike-refute',
] as const;

for (const id of EXPECTED_IDS) {
  assert.ok(EXPLAINER_TEMPLATES.some((t) => t.id === id), `missing ${id} in EXPLAINER_TEMPLATES`);
  assert.ok(TEMPLATES.some((t) => t.id === id), `missing ${id} in TEMPLATES`);
}

let history: History = {
  past: [],
  present: docFromTimeline({ fps: 30, width: 1920, height: 1080, items: [], selectedId: null }),
  future: [],
};
const commands = buildCommands((action) => { history = historyReduce(history, action); }, () => history.present);

for (const template of EXPLAINER_TEMPLATES) {
  assert.ok(TEMPLATES.includes(template), `${template.id} registered in TEMPLATES`);
  assert.ok(template.thumb?.startsWith('data:image/svg+xml'), `${template.id} has svg thumb`);
  assert.ok(template.propSchema.length >= 5, `${template.id} has editable schema`);
  validateTemplate(template.code);
  await prepareTemplate(template.code);

  const itemId = commands.addMotionGraphic(template, {
    durationInFrames: 180,
    name: `${template.name}-测试`,
    props: { customTag: 'verified' },
  });
  const timeline = history.present.timelines[0];
  const item = timeline.items.find((entry) => entry.id === itemId)!;
  assert.ok(item);
  assert.equal(item.templateId, template.id);
  assert.equal(item.durationInFrames, 180);
  assert.equal(item.name, `${template.name}-测试`);
  assert.equal(item.props?.customTag, 'verified');
}

const first = history.present.timelines[0].items[0];
history = historyReduce(history, {
  type: 'updateProps',
  id: first.id,
  patch: { labelText: '修改后标签', leaderDir: 'down', lockStartSec: 0.7 },
});
assert.equal(history.present.timelines[0].items[0].props?.labelText, '修改后标签');
assert.equal(history.present.timelines[0].items[0].props?.leaderDir, 'down');

const edited = history.present;
history = historyReduce(history, { type: 'undo' });
assert.notEqual(history.present.timelines[0].items[0].props?.labelText, '修改后标签');
history = historyReduce(history, { type: 'redo' });
assert.deepEqual(history.present, edited);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(null, { status: 404 });
try {
  resetProjectStoreMemory();
  const meta = await createProject('explainer-suite-regression', edited);
  await saveProject(meta.id, edited);
  await flushProjectSaves();
  const reopened = await loadProject(meta.id);
  assert.ok(reopened);
  assert.deepEqual(
    reopened.timelines[0].items.map((item) => item.props),
    edited.timelines[0].items.map((item) => item.props),
  );
  assert.equal(reopened.timelines[0].items[0].code, first.code);
} finally {
  resetProjectStoreMemory();
  globalThis.fetch = originalFetch;
}

// computeScanFocusLayout: empty label hides card, custom endX/endY auto-bends leader
{
  const def = computeScanFocusLayout(undefined, 1920, 1080);
  assert.equal(def.hasLabelCard, true);
  assert.equal(def.labelText, '重点目标锁定');

  const cleared = computeScanFocusLayout({ labelText: '' }, 1920, 1080);
  assert.equal(cleared.hasLabelCard, false);
  assert.equal(cleared.labelText, '');

  const blank = computeScanFocusLayout({ labelText: '   ', subText: ' ' }, 1920, 1080);
  assert.equal(blank.hasLabelCard, false);

  const subOnly = computeScanFocusLayout({ labelText: '', subText: '备注' }, 1920, 1080);
  assert.equal(subOnly.hasLabelCard, true);

  const rightUp = computeScanFocusLayout({ boxX: 35, boxY: 55, boxW: 20, boxH: 20, endX: 72, endY: 22, labelText: '' }, 1920, 1080);
  assert.equal(rightUp.hasLabelCard, false);
  assert.equal(rightUp.pointsLeft, false);
  assert.ok(rightUp.ax > rightUp.cx && rightUp.mx > rightUp.ax && rightUp.mx < rightUp.ex);
  assert.ok(Math.abs(rightUp.ex - 0.72 * 1920) < 0.01);
  assert.ok(Math.abs(rightUp.ey - 0.22 * 1080) < 0.01);
  assert.ok(Math.abs(rightUp.my - rightUp.ey) < 0.01);

  const leftDown = computeScanFocusLayout({ boxX: 65, boxY: 35, boxW: 20, boxH: 20, endX: 20, endY: 70 }, 1920, 1080);
  assert.equal(leftDown.pointsLeft, true);
  assert.ok(leftDown.ax < leftDown.cx && leftDown.mx < leftDown.ax && leftDown.mx > leftDown.ex);
  assert.ok(Math.abs(leftDown.ex - 0.20 * 1920) < 0.01);
  assert.ok(Math.abs(leftDown.ey - 0.70 * 1080) < 0.01);

  const topBend = computeScanFocusLayout({ boxX: 50, boxY: 65, boxW: 24, boxH: 20, endX: 54, endY: 18 }, 1920, 1080);
  assert.equal(topBend.ax, topBend.cx);
  assert.equal(topBend.ay, topBend.y0);
  assert.ok(Math.abs(topBend.ex - 0.54 * 1920) < 0.01);
  assert.ok(Math.abs(topBend.ey - 0.18 * 1080) < 0.01);
}

console.log('explainerTemplates.verify: all 5 explainer kits compile in sandbox, scan-focus layout/empty-label/endpoint-bend, undo/redo, save and reopen OK');
