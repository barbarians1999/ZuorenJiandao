import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { TimelineItem } from '../editor/types';

const localeId = '\0pasted-panel-locale';
const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null }, plugins: [{ name: 'caption-panel-test-locale', enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) { return id === localeId ? "const tr = (text, values = {}) => text.replace(/\\{([^}]+)\\}/g, (_, key) => String(values[key] ?? ('{' + key + '}'))); export const useT = () => tr; export const t = tr;" : null; },
  }] });
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => '你好，这是口播文字稿。' } });
try {
  const { PasteTranscriptBox } = await server.ssrLoadModule('/src/captions/CaptionsPanel.tsx');
  const voice: TimelineItem = { id: 'voice', name: '口播', kind: 'audio', track: 'A1', src: '/media/uploads/voice.wav', startFrame: 0, durationInFrames: 90 };
  const html = (items: TimelineItem[]) => renderToStaticMarkup(createElement(PasteTranscriptBox, {
    items, fps: 30, trackOptions: [{ id: 'A1', alias: 'A1', kind: 'audio' }], existingNames: [], draftKey: 'test',
    onCreate() { throw Error('render must not create subtitles'); },
  }));
  const unrecognized = html([voice]);
  assert.match(unrecognized, /识别时间并生成字幕/);
  assert.doesNotMatch(unrecognized, /disabled=""[^>]*>识别时间并生成字幕/);
  assert.match(unrecognized, /你好，这是口播文字稿。/);
  assert.match(unrecognized, /生成前会再次确认/);
  assert.match(unrecognized, /重新检查模型/);
  assert.doesNotMatch(unrecognized, /还有 1 个片段没有口播时间|字幕来源：A1|选择口播轨道 →/);
  const ready = html([{ ...voice, transcript: [{ text: '你好', start: 0, end: 1000 }] }]);
  assert.match(ready, />生成字幕<\/button>/);
  assert.doesNotMatch(ready, /口播时间已就绪；生成后会进入字幕列表逐句校对/);
  assert.doesNotMatch(ready, /识别时间并生成字幕/);
  assert.doesNotMatch(ready, /重新检查模型/, 'cached timing must not require installing a model');
  const empty = html([]);
  assert.match(empty, /请先把口播视频或音频拖入时间线/);
  assert.match(empty, /disabled=""[^>]*>生成字幕/);
  assert.match(empty, /双击时间线上的子草稿/);
  console.log('pastedTranscriptPanel.verify: unrecognized track has an enabled action, cached timing is reused, draft survives and empty input explains next step');
} finally {
  if (originalStorage) Object.defineProperty(globalThis, 'sessionStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
  await server.close();
}
