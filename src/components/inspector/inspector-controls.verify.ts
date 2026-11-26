import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyframeResetBatch } from '../../editor/keyframeReset';
import { clampScalar, scalarModifier, scrubScalar, snapScalar, wheelStepScalar } from './scalarMath';

assert.equal(scalarModifier({ shiftKey: false, metaKey: false }), 1);
assert.equal(scalarModifier({ shiftKey: true, metaKey: false }), 10);
assert.equal(scalarModifier({ shiftKey: false, metaKey: true }), 0.1);
assert.equal(scrubScalar(1, 2, 0.05, 0, 2, { shiftKey: false, metaKey: false }), 1.1);
assert.equal(scrubScalar(1, 2, 0.05, 0, 2, { shiftKey: true, metaKey: false }), 2);
assert.equal(scrubScalar(1, -100, 0.05, 0, 2, { shiftKey: false, metaKey: true }), 0.5);
assert.equal(clampScalar(9, 0, 2), 2);
assert.equal(snapScalar(1.373, 0, 2, 0.05), 1.35);
assert.equal(wheelStepScalar(1, -120, 0.05, 0, 2), 1.05);
assert.equal(wheelStepScalar(1, 120, 0.05, 0, 2), 0.95);
assert.equal(wheelStepScalar(1.9, -120, 0.05, 0, 2, { shiftKey: true, metaKey: false }), 2);
assert.equal(wheelStepScalar(1, 120, 0.05, 0, 2, { shiftKey: false, metaKey: true }), 0.995);
assert.equal(wheelStepScalar(1, 0, 0.05, 0, 2), 1);

const row = keyframeResetBatch('clip-1', ['volume']);
assert.equal(row.label, 'Reset volume');
assert.deepEqual(row.actions, [
  { type: 'clearKeyframes', id: 'clip-1', prop: 'volume' },
  { type: 'setVolume', id: 'clip-1', volume: 1 },
]);

const group = keyframeResetBatch('clip-1', ['scale', 'x', 'y', 'rotation', 'opacity']);
assert.equal(group.label, 'Reset transform');
assert.deepEqual(group.actions.at(-1), {
  type: 'setTransform',
  id: 'clip-1',
  // Uniform scale reset also re-links scaleX/scaleY so non-uniform residue is cleared.
  patch: { scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0, opacity: 1, crop: undefined },
});

const transformSource = readFileSync(new URL('./InspectorKeyframeControls.tsx', import.meta.url), 'utf8');
assert.match(transformSource, /label: '裁左'/, 'Transform 分组在圆角下应有裁左');
assert.match(transformSource, /label: '裁右'/, 'Transform 分组应有裁右');
assert.match(transformSource, /label: '裁上'/, 'Transform 分组应有裁上');
assert.match(transformSource, /label: '裁下'/, 'Transform 分组应有裁下');
assert.match(transformSource, /CROP_ROWS\.map/, '四边裁切应排在关键帧行之后');

const captionSource = readFileSync(new URL('./CaptionInspectorControls.tsx', import.meta.url), 'utf8');
assert.match(captionSource, /<div className="cc-insp-body">\s*<div className="cc-insp-groups" data-caption-inspector="true">/s, '字幕属性应包裹在可纵向滚动的 cc-insp-body 容器中');

for (const file of [
  'InspectorKeyframeControls.tsx',
  'BackgroundFillControl.tsx',
  'CaptionInspectorControls.tsx',
  'PictureAnimationControl.tsx',
  'PropSchemaField.tsx',
  'InspectorVisualControls.tsx',
  'InspectorMediaControls.tsx',
]) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /useInspectorWheel\([^)]*(?:rangeRef|durationRangeRef)/, `${file}: 滚轮调节不应绑定在左侧滑动条上`);
}
const scalarSource = readFileSync(new URL('./ScalarControl.tsx', import.meta.url), 'utf8');
assert.match(scalarSource, /useInspectorWheel\(buttonRef/, '右侧数值框应保留滚轮调节');
assert.match(scalarSource, /useInspectorWheel\(inputRef/, '右侧数字输入框应保留滚轮调节');

const inspectorPanelSource = readFileSync(new URL('../InspectorPanel.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(inspectorPanelSource, /cc-insp-chevron|收起属性/, '属性栏标题栏不应再带无效的折叠小三角或收起按钮');

const inspectorContentSource = readFileSync(new URL('./InspectorContent.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(inspectorContentSource, /画面 \/ 文字/, '属性页标签不得再使用合并的 画面 / 文字');

const uiPolishCss = readFileSync(new URL('../../editor/editor-ui-polish.css', import.meta.url), 'utf8');
assert.match(uiPolishCss, /\.cc-editor-shell \.cc-insp-tabs\s*\{[^}]*flex-wrap:\s*nowrap;/s, '属性页标签栏应强制单行不换行');
assert.match(uiPolishCss, /\.cc-editor-shell \.cc-insp-tabs button\s*\{[^}]*padding:\s*0 4px;[^}]*white-space:\s*nowrap;/s, '属性页标签按钮应使用紧凑内边距且文字不换行');

console.log('inspector-controls.verify: ok');
