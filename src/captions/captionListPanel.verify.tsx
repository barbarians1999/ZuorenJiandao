import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { CaptionsData } from './types';

const localeId = '\0caption-list-test-locale';
const server = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null }, plugins: [{ name: 'caption-list-test-locale', enforce: 'pre',
    resolveId(id) { return /\/i18n\/locale(?:\.ts)?$/.test(id) ? localeId : null; },
    load(id) { return id === localeId ? 'export const useT = () => (text) => text; export const t = (text) => text; export const tData = (text) => text;' : null; },
  }] });
const captions: CaptionsData = { enabled: true, template: 'plain', pacing: 'phrase', sourceMode: 'item', sourceEntries: [{
  id: 'manual', itemId: 'manual:manual', words: Array.from({ length: 1000 }, (_, index) => ({ id: `cue${index}`, text: `字幕${index}`, start: index * 2000, end: index * 2000 + 1000 })),
}] };
try {
  const { CaptionCueEditor } = await server.ssrLoadModule('/src/captions/CaptionCueEditor.tsx');
  const html = renderToStaticMarkup(createElement(CaptionCueEditor, { captions, items: [], fps: 30, captionTrackId: 'C1',
    selectedCaptions: [{ trackId: 'C1', kind: 'manual', laneId: 'manual', cueId: 'cue0' }],
    onUpdate() { throw new Error('render must not edit'); }, onSeekMs() { throw new Error('render must not seek'); },
  }));
  assert((html.match(/data-cue-id=/g) ?? []).length <= 16, '1000 subtitles do not create 1000 mounted editor rows');
  assert.match(html, /自动跟随/); assert.match(html, /全部替换/); assert.match(html, /删除所选/);
  assert.doesNotMatch(html, />编辑</);
  assert.doesNotMatch(html.slice(html.indexOf('cc-caption-list-scroll')), /type="checkbox"/);
  assert.doesNotMatch(html, /cc-caption-list-time/);
  assert.match(html, /在后面添加新字幕/);
  assert.match(html, /删除字幕：/);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1, 'timeline selection is visible in the list');
  assert.match(html, /data-caption-selection-owner="list"/);
  const { readFileSync } = await import('node:fs');
  const cueEditorSource = readFileSync(new URL('./CaptionCueEditor.tsx', import.meta.url), 'utf8');
  assert.match(cueEditorSource, /top \+ rowHeight \/ 2 - element\.clientHeight \/ 2/, 'follow mode centers the active cue vertically');
  assert.match(cueEditorSource, /reveal\(activeId, \{ center: true \}\)/, 'playback follow uses centered reveal');
  assert.match(cueEditorSource, /if \(playing\) activationPriority\.current = null;/, 'playback clears stale timeline-click activation lock');
  assert.match(cueEditorSource, /editorRef\.current\?\.blur\(\);/, 'starting playback blurs unmodified/idle inline editor so auto-follow stays active');
  assert.match(cueEditorSource, /if \(draft\?\.id !== id\) edit\(row\);/, 'single-clicking a caption row enters edit mode directly');
  const { ManualCaptionEditor } = await server.ssrLoadModule('/src/captions/ManualCaptionEditor.tsx');
  const manual = renderToStaticMarkup(createElement(ManualCaptionEditor, { captions, items: [], showCueList: false, onUpdate() {} }));
  assert.doesNotMatch(manual, /cc-cap-manual-row/); assert.match(manual, /导入 SRT 字幕/); assert.match(manual, /添加字幕/);
  console.log('captionListPanel.verify: bounded 1000-cue list rendering, visible timeline selection, search/batch/follow controls and no duplicate manual list');
} finally { await server.close(); }
