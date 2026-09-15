import assert from 'node:assert/strict';
import { EMPTY_PROJECT_STARTERS, QUICK_ACTIONS } from './chatPanelPresets';

const labels = ['简单剪辑', '添加背景音乐', '粘贴文字稿生成字幕'];
assert.deepEqual(EMPTY_PROJECT_STARTERS.map((entry) => entry.label), labels);
assert.deepEqual(QUICK_ACTIONS.map((entry) => entry.label), labels);
assert.ok(EMPTY_PROJECT_STARTERS.every((entry) => entry.prompt.includes('当前工程')));
assert.ok(QUICK_ACTIONS.every((entry) => entry.prompt.includes('当前工程')));
console.log('chatPanelPresets.verify: focused starters are limited to three core actions');
