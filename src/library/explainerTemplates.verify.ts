import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Babel from '@babel/standalone';
import { computeScanFocusLayout, EXPLAINER_TEMPLATES } from './explainerTemplates';
import { TEMPLATES } from '../editor/initial';
import { prepareTemplate, validateTemplate, type MgComponent } from '../template-host';
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

assert.equal(EXPLAINER_TEMPLATES.length, 8);
assert.equal(new Set(TEMPLATES.map((template) => template.id)).size, TEMPLATES.length);

const EXPECTED_IDS = [
  'zuoren-explainer-scan-focus',
  'zuoren-explainer-flow-steps',
  'zuoren-explainer-data-counter',
  'zuoren-explainer-quote-card',
  'zuoren-explainer-strike-refute',
  'zuoren-explainer-bar-chart',
  'zuoren-explainer-line-chart',
  'zuoren-explainer-pie-chart',
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
  assert.ok(template.propSchema.length >= 5 && template.propSchema.length <= 32, `${template.id} schema length ${template.propSchema.length} within 5..32`);
  assert.equal(new Set(template.propSchema.map((s) => s.key)).size, template.propSchema.length, `${template.id} unique schema keys`);
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

// Compile-and-render helper to verify frame-by-frame output of explainer kits
function compileForFrameRender(code: string, getFrame: () => number, fps = 30): MgComponent {
  const match = code.match(/const\s+([A-Za-z_$][\w$]*)\s*=/);
  if (!match) throw new Error('component name not found');
  const transpiled = Babel.transform(code, {
    presets: [['react', { runtime: 'classic' }]],
    filename: 'template.jsx',
  })?.code;
  if (!transpiled) throw new Error('babel produced empty output');
  const AbsoluteFill: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) =>
    React.createElement('div', { style }, children);
  const factory = new Function(
    'React',
    'useCurrentFrame',
    'useVideoConfig',
    'AbsoluteFill',
    `"use strict";\n${transpiled}\n;return ${match[1]};`,
  );
  return factory(React, getFrame, () => ({ fps, width: 1920, height: 1080 }), AbsoluteFill) as MgComponent;
}

function renderTemplateHtml(
  id: string,
  frame: number,
  propsOverride: Record<string, unknown> = {},
  durationInFrames = 300,
): string {
  const tpl = EXPLAINER_TEMPLATES.find((t) => t.id === id)!;
  assert.ok(tpl, `template ${id} exists`);
  let currentFrame = frame;
  const Comp = compileForFrameRender(tpl.code, () => currentFrame, tpl.fps);
  const html = renderToStaticMarkup(
    React.createElement(Comp, {
      item: {
        props: { ...tpl.props, ...propsOverride },
        width: tpl.width,
        height: tpl.height,
        durationInFrames,
        frameOffset: 0,
      },
    }),
  );
  assert.ok(!/\bNaN\b/.test(html), `${id} frame=${frame} must not contain NaN`);
  return html;
}

// 1. data-counter: long clips past 1.3s stay locked on endValue (never jump back to startValue)
{
  const startHtml = renderTemplateHtml('zuoren-explainer-data-counter', 0, {}, 600);
  assert.ok(startHtml.includes('15.8'), 'data-counter starts at 15.8');

  const midHtml = renderTemplateHtml('zuoren-explainer-data-counter', 24, {}, 600);
  assert.ok(!midHtml.includes('3,178'), 'data-counter is still rolling before rollEndSec');

  for (const frame of [54, 90, 150, 300, 580]) {
    const html = renderTemplateHtml('zuoren-explainer-data-counter', frame, {}, 600);
    assert.ok(html.includes('3,178'), `data-counter frame=${frame} locks cleanly on 3,178`);
  }

  // Repro case: 1.3s rollEndSec in a 10s clip
  for (const frame of [39, 45, 90, 180, 270]) {
    const html = renderTemplateHtml('zuoren-explainer-data-counter', frame, {
      startValue: 135,
      endValue: 3448,
      rollStartSec: 0.2,
      rollEndSec: 1.3,
    }, 300);
    assert.ok(html.includes('3,448'), `data-counter rollEndSec=1.3 frame=${frame} stays at 3,448`);
  }

  // Explicit frame override
  const byFrame = renderTemplateHtml('zuoren-explainer-data-counter', 60, {
    startValue: 10,
    endValue: 999,
    rollStartFrame: 10,
    rollEndFrame: 40,
  }, 180);
  assert.ok(byFrame.includes('999'), 'data-counter rollEndFrame override locks at 999');
}

// 2. strike-refute: duration & long-clip stability
{
  const pre = renderTemplateHtml('zuoren-explainer-strike-refute', 5, {}, 300);
  assert.ok(!pre.includes('scaleX('), 'strike line hidden before strikeStartSec');
  for (const frame of [40, 120, 280]) {
    const settled = renderTemplateHtml('zuoren-explainer-strike-refute', frame, {}, 300);
    assert.ok(settled.includes('scaleX(1)'), `strike line locked at scaleX(1) on frame=${frame}`);
  }
}

// 3. bar-chart: horizontal & vertical + themes + custom display text + timing
{
  const h0 = renderTemplateHtml('zuoren-explainer-bar-chart', 0);
  assert.ok(h0.includes('工业化进程耗时对比'));
  const h150 = renderTemplateHtml('zuoren-explainer-bar-chart', 150, {
    itemsText: '德国 | 45 | 年 | 40 多年\n日本 | 78 | 年 | 近 80 年\n*新中国 | 27 | 年 | 27 年',
    themePreset: 'crimson-archive',
  });
  assert.ok(h150.includes('40 多年') && h150.includes('近 80 年') && h150.includes('#d4af37'));

  const v150 = renderTemplateHtml('zuoren-explainer-bar-chart', 150, {
    orientation: 'vertical',
    itemsText: '1952年 | 135 | 万吨\n*1979年 | 3448 | 万吨',
  });
  assert.ok(v150.includes('135 万吨') && v150.includes('3,448 万吨'));
}

// 4. line-chart: linear & smooth + multi-series + highlight node callouts
{
  const linearHtml = renderTemplateHtml('zuoren-explainer-line-chart', 90);
  assert.ok(linearHtml.includes('历年钢产量增长趋势') && linearHtml.includes('3,448 万吨'));

  const smoothMulti = renderTemplateHtml('zuoren-explainer-line-chart', 120, {
    curveMode: 'smooth',
    seriesText: '*甲国 | 10, 40, 90, 160\n乙国 | 20, 35, 60, 85\n丙国 | 5, 18, 42, 70',
    xLabels: '1950, 1960, 1970, 1980',
    highlightNodes: '1980',
    themePreset: 'crimson-archive',
  });
  assert.ok(smoothMulti.includes('甲国') && smoothMulti.includes('乙国') && smoothMulti.includes('丙国'));
  assert.ok(smoothMulti.includes(' C'), 'smooth mode emits cubic Bezier C commands');
}

// 5. pie-chart: dual morph & single donut/pie + 100% single slice safety
{
  const dualHtml = renderTemplateHtml('zuoren-explainer-pie-chart', 120);
  assert.ok(dualHtml.includes('1949 年') && dualHtml.includes('1978 年') && dualHtml.includes('80% → 20%'));

  const singlePie = renderTemplateHtml('zuoren-explainer-pie-chart', 120, {
    layoutMode: 'single',
    chartStyle: 'pie',
    slicesText: '*公有制经济 | 65\n个体经济 | 20\n其他 | 15',
    themePreset: 'transparent-light',
  });
  assert.ok(singlePie.includes('公有制经济 65%') && singlePie.includes('个体经济 20%'));

  const fullSlice = renderTemplateHtml('zuoren-explainer-pie-chart', 120, {
    layoutMode: 'single',
    slicesText: '*全部 | 100\n其余 | 0',
  });
  assert.ok(fullSlice.includes('100%'));
}

console.log('explainerTemplates.verify: all 8 explainer kits compile in sandbox, data-counter/strike-refute stability, bar/line/pie charts, scan-focus layout, undo/redo, save and reopen OK');
