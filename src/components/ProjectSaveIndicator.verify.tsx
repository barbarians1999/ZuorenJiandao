import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectSaveIndicator } from './ProjectSaveIndicator';


const retry = async () => true;
const error = renderToStaticMarkup(<ProjectSaveIndicator saveStatus="error" saveError="Disk full" onRetrySave={retry} />);
assert.match(error, />重试保存<\/button>/);
assert.match(error, /保存失败/);
assert.match(error, /Disk full/);
const busy = renderToStaticMarkup(<ProjectSaveIndicator saveStatus="saving" onRetrySave={retry} />);
assert.match(busy, /aria-busy="true"/);
assert.doesNotMatch(busy, /<button/);
assert.match(renderToStaticMarkup(<ProjectSaveIndicator />), /已保存/);
const wiring = readFileSync(new URL('../editor/useEditorController.tsx', import.meta.url), 'utf8');
assert.match(wiring, /onRetrySave: retrySave/);
const persistence = readFileSync(new URL('../editor/useEditorProjectPersistence.ts', import.meta.url), 'utf8');
assert.doesNotMatch(persistence, /seekTo\(0\)/, 'saving must not override per-draft playhead restoration');
const playhead = readFileSync(new URL('./timeline/usePlayheadPaint.ts', import.meta.url), 'utf8');
assert.match(playhead, /if \(!isCurrentTimeline\(\)\) return;/);
assert.match(playhead, /persistHead\(playheadRef.current\)/);
assert.match(playhead, /\}, \[playerRef, projectId, timelineId\]\)/);
const feedbackCss = readFileSync(new URL('./editorFeedback.css', import.meta.url), 'utf8');
assert.ok([...feedbackCss.matchAll(/font-size:\s*(\d+)px/g)].every((match) => Number(match[1]) >= 14),
  'new save and attachment feedback must not reintroduce tiny secondary UI');
console.log('ProjectSaveIndicator.verify: accessible retry/busy UI and persistence/playhead wiring passed (SSR, not mounted playback)');
