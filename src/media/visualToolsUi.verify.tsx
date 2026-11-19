import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// 1. Verify AddSolidCanvasCard rendering with different labels and icons
const { AddSolidCanvasCard } = await import('./AddSolidCanvasCard');

const rectCardHtml = renderToStaticMarkup(createElement(AddSolidCanvasCard, {
  label: '添加矩形',
  onAdd: () => {},
}));
assert.match(rectCardHtml, /添加矩形/);
assert.match(rectCardHtml, /cc-add-solid-canvas-card/);

const mosaicCardHtml = renderToStaticMarkup(createElement(AddSolidCanvasCard, {
  label: '添加独立马赛克',
  icon: 'grid',
  onAdd: () => {},
}));
assert.match(mosaicCardHtml, /添加独立马赛克/);
assert.match(mosaicCardHtml, /cc-add-solid-canvas-thumb/);

// 2. Source-level contract verification
const gridSource = readFileSync(new URL('./MediaPoolGrid.tsx', import.meta.url), 'utf8');
assert.match(gridSource, /kind: 'shape-rectangle'/, '网格条目必须包含矩形形状');
assert.match(gridSource, /kind: 'shape-ellipse'/, '网格条目必须包含椭圆形状');
assert.match(gridSource, /kind: 'mosaic'/, '网格条目必须包含独立马赛克');
assert.match(gridSource, /onAddShape\?\.?\('rectangle'\)/, '矩形卡片必须调用 onAddShape');
assert.match(gridSource, /onAddShape\?\.?\('ellipse'\)/, '椭圆卡片必须调用 onAddShape');
assert.match(gridSource, /onAddMosaic\?\.?\(\)/, '马赛克卡片必须调用 onAddMosaic');

const toolbarSource = readFileSync(new URL('./MediaPoolToolbar.tsx', import.meta.url), 'utf8');
assert.match(toolbarSource, /添加矩形/, '工具栏更多菜单必须提供添加矩形按钮');
assert.match(toolbarSource, /添加椭圆/, '工具栏更多菜单必须提供添加椭圆按钮');
assert.match(toolbarSource, /添加独立马赛克/, '工具栏更多菜单必须提供添加独立马赛克按钮');

const panelSource = readFileSync(new URL('./MediaPoolPanel.tsx', import.meta.url), 'utf8');
assert.match(panelSource, /onAddShape \? \[\s*\{ kind: 'shape-rectangle' as const \},\s*\{ kind: 'shape-ellipse' as const \},\s*\] : \[\]/, '素材面板必须在根目录注入形状卡片');
assert.match(panelSource, /onAddMosaic \? \[\{ kind: 'mosaic' as const \}\] : \[\]/, '素材面板必须在根目录注入马赛克卡片');

const controllerSource = readFileSync(new URL('../editor/useEditorController.tsx', import.meta.url), 'utf8');
assert.match(controllerSource, /onAddShape: \(shape/, '控制器必须向素材区暴露添加形状命令');
assert.match(controllerSource, /commands\.addShapeItem\(shape, \{ startFrame: getPlayhead\(\) \}\)/, '添加形状必须在当前播放头创建');
assert.match(controllerSource, /onAddMosaic: \(\) =>/, '控制器必须向素材区暴露添加马赛克命令');
assert.match(controllerSource, /commands\.addCompositionMosaic\(\{ startFrame: getPlayhead\(\) \}\)/, '添加马赛克必须在当前播放头创建');
assert.match(controllerSource, /onCompositionMosaicChange: \(patch\) => applyInspectorSelection/, '检查器必须处理独立马赛克属性变更');

console.log('visualToolsUi.verify: shape and mosaic visual tool controls and controller integration verified');
