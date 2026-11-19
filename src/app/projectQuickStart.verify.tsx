import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PROJECT_QUICK_STARTS, editorRouteFromHash, projectEditorHash } from './projectQuickStart';
import { createServer } from 'vite';
import type { TextWorkspaceProps } from '../library/TextWorkspace';

const localeId = '\0quick-start-test-locale';
const captionsId = '\0text-workspace-test-captions';
const transcriptId = '\0text-workspace-test-transcript';
const vite = await createServer({ configFile: false, appType: 'custom', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, watch: null }, plugins: [{
  name: 'quick-start-test-locale', enforce: 'pre',
  resolveId(id, importer) {
    if (/\/i18n\/locale(?:\.ts)?$/.test(id)) return localeId;
    if (id === '../captions/CaptionsPanel' && importer?.endsWith('/TextWorkspace.tsx')) return captionsId;
    if (id === '../transcript/TranscriptPanel' && importer?.endsWith('/TextWorkspace.tsx')) return transcriptId;
    return null;
  },
  load(id) {
    if (id === localeId) return 'export const t = (text) => text; export const useT = () => t;';
    if (id === captionsId) return `import React from 'react'; export function CaptionsPanel(p) { return React.createElement('div', { 'data-test-captions': '', 'data-project': p.projectId, 'data-timeline': p.timelineId, 'data-draft': p.draftKey, 'data-paste': p.openPasteTranscriptRequest, 'data-track-request': p.selectTrackRequest?.trackId ?? '', 'data-activation-track': p.captionActivationRequest?.selection?.trackId ?? '', 'data-activation-nonce': p.captionActivationRequest?.nonce ?? '' }); }`;
    if (id === transcriptId) return `import React from 'react'; export function TranscriptPanel(p) { return React.createElement('div', { 'data-test-transcript': '', 'data-clear': !!p.onClearEdits, 'data-srt': !!p.onImportSrt, 'data-styles': !!p.onOpenCaptionStyles }); }`;
    return null;
  },
}] });

try {
const { ExternalControlDock } = await vite.ssrLoadModule('/src/components/ExternalControlHost.tsx');
const { QuickStartGuide } = await vite.ssrLoadModule('/src/library/QuickStartGuide.tsx');

assert.equal(editorRouteFromHash('#/'), null);
assert.equal(editorRouteFromHash('#/editor/%broken'), null);
assert.deepEqual(editorRouteFromHash('#/editor/existing'), { id: 'existing' });
assert.deepEqual(editorRouteFromHash('#/editor/existing?start=unknown'), { id: 'existing' });
assert.deepEqual(editorRouteFromHash('#/editor/existing?start=music'), { id: 'existing' });
for (const { intent } of PROJECT_QUICK_STARTS) {
  assert.deepEqual(editorRouteFromHash(projectEditorHash('工程 / one', intent)), { id: '工程 / one', quickStart: intent });
  const guide = renderToStaticMarkup(createElement(QuickStartGuide, { intent, onImport() {}, onPaste() {}, onDismiss() {} }));
  assert.match(guide, /cc-quick-start-guide/);
  assert.match(guide, /button/);
}
assert.equal(renderToStaticMarkup(createElement(ExternalControlDock, { visible: false }, 'hidden')), '');
const dock = renderToStaticMarkup(createElement(ExternalControlDock, { visible: true }, 'review'));
assert.match(dock, /cc-external-control-dock/);
assert.doesNotMatch(dock, /position:fixed|z-index/);
const workspace = await readFile(new URL('../editor/EditorWorkspaceView.tsx', import.meta.url), 'utf8');
assert.equal((workspace.match(/<ExternalControlHost/g) ?? []).length, 1, 'exactly one bridge owns the editor');
assert.match(workspace, /cc-editor-preview-column[\s\S]*?<ExternalControlHost/);
assert.match(workspace, /setMode\('text'\)/, 'caption selection and paste requests open the right text workspace');
assert.match(workspace, /selectedItemId/, 'a new timeline item selection restores the inspector');
assert.match(workspace, /onActivateCaptionWorkspace=\{rightPanel\.activateCaption\}/, 'clicking an already-selected timeline cue opens and locates it in the subtitle workspace');
assert.match(workspace, /captionActivationRequest: rightPanel\.captionActivationRequest/, 'the activation request reaches the retained right workspace');
const css = await readFile(new URL('../index.css', import.meta.url), 'utf8');
const captionCss = await readFile(new URL('../captions/caption-list.css', import.meta.url), 'utf8');
assert.match(css, /\.cc-inspector-host, \.cc-text-workspace-host\s*\{[^}]*position:absolute/, 'right-side tools remain usable in a narrow preview column');
assert.match(css, /\.cc-text-workspace-host\s*\{[^}]*container:text-workspace \/ inline-size/);
assert.match(css, /@container text-workspace \(max-width:420px\)[\s\S]*\.cc-text-workspace-tabs button[^}]*white-space:nowrap/, 'subtitle tabs keep a single line in a narrow text panel');
assert.match(captionCss, /\.cc-text-workspace-page > \.cc-captions-workspace\s*\{[^}]*overflow:hidden/, 'the text workspace owns one bounded caption viewport');
assert.match(captionCss, /data-view="list"[^]*?\.cc-cap-body\s*\{[^}]*flex:1[^}]*min-height:0[^}]*overflow:auto/);
const cueSource = await readFile(new URL('../captions/CaptionCueEditor.tsx', import.meta.url), 'utf8');
assert.match(cueSource, /<details className="cc-caption-list-tools">[\s\S]*cc-caption-list-scroll/, 'search and bulk tools start collapsed ahead of the list viewport');
const captionsControlsSource = await readFile(new URL('../captions/CaptionsControls.tsx', import.meta.url), 'utf8');
assert.match(captionsControlsSource, /<ManualCaptionEditor[\s\S]*<\/details>/, 'manual caption controls remain reachable inside the collapsed details');
assert.match(captionsControlsSource, /if \(focusManualLane\) setOptionsOpen\(true\)/, 'a requested manual-lane focus opens its details first');
const captionsPanelSource = await readFile(new URL('../captions/CaptionsPanel.tsx', import.meta.url), 'utf8');
assert.match(captionsPanelSource, /CaptionTrackBar[\s\S]*onImportSrt[\s\S]*导入 SRT/, 'SRT import remains visible beside the track selector without a separate row');
assert.match(cueSource, /selectedCaptionListIds\(captionTrackId, rows, \[request\.selection\]\)/, 'reveal uses the current cue identity mapping');
assert.match(cueSource, /if \(!target\) \{[\s\S]*setPendingActivationReveal\(\{ id: targetId, nonce: request\.nonce \}\)/, 'a virtualized row schedules a later reveal pass');
assert.match(cueSource, /target\.scrollIntoView\(\{ block: 'center', inline: 'nearest' \}\);[\s\S]*onCaptionActivationConsumed\?\.\(request\.nonce\)/, 'activation is acknowledged only after the rendered row scrolls into view');
const { LibraryNavigation } = await vite.ssrLoadModule('/src/library/LibraryNavigation.tsx');
const navigation = renderToStaticMarkup(createElement(LibraryNavigation, { active: '字幕', onSelect() {} }));
assert.match(navigation, /字幕/);
assert.match(navigation, /插入文字/);
assert.match(navigation, /我的素材/);
assert.match(navigation, /音效/);
assert.doesNotMatch(navigation, /文本与字幕|>文字稿<|背景音乐/);
const { TextWorkspace } = await vite.ssrLoadModule('/src/library/TextWorkspace.tsx');
const noop = () => undefined;
const textProps = {
  timelineId: 'timeline-a', semanticScopeId: 'project-a', playerRef: { current: null }, fps: 30,
  items: [], trackOptions: [], captionTracks: [], onSetCaptions: noop, onCreateCaptionTrack: () => 'C1',
  onUpdateCaptions: noop, selectedCaptions: [], onSelectCaption: noop, onSelectCaptionRange: noop,
  onSetItemTranscript: noop, onToggleWord: noop, onCleanScript: noop, onSetGapCap: noop,
  onSetTranscriptPlayOrder: noop, onReorderTrackItems: noop, onClearEdits: noop,
  selectedItem: null, onAddText: noop, page: '字幕', onPageChange: noop, onClose: noop,
  pasteTranscriptRequest: 7,
  captionActivationRequest: { selection: { trackId: 'C2', kind: 'manual', laneId: 'L2', cueId: 'cue2' }, nonce: 9, identity: 'project-a:timeline-a' },
} satisfies TextWorkspaceProps;
const textHtml = renderToStaticMarkup(createElement(TextWorkspace, textProps));
assert.match(textHtml, /aria-label="字幕列表"/);
assert.match(textHtml, /data-project="project-a" data-timeline="timeline-a" data-draft="project-a:timeline-a" data-paste="7" data-track-request="" data-activation-track="C2" data-activation-nonce="9"/);
assert.doesNotMatch(textHtml, /data-test-transcript/, 'transcription and model readiness do not run before opening that page');
const textSource = await readFile(new URL('../library/TextWorkspace.tsx', import.meta.url), 'utf8');
assert.match(textSource, /key=\{`\$\{semanticScopeId\}:\$\{timelineId\}`\}/, 'caption panel identity and recovery key stay project/timeline scoped');
assert.match(textSource, /captionActivationRequest\?\.identity === identity/, 'a cue reveal request is scoped to the active project/timeline');
assert.match(cueSource, /selectedCaptionListIds\(captionTrackId, rows, \[request\.selection\]\)/, 'reveal uses the current cue identity mapping');
const librarySource = await readFile(new URL('../library/LibraryPanel.tsx', import.meta.url), 'utf8');
assert.match(librarySource, /onRequestPasteTranscript\?\.\(\)/, 'quick start paste emits a fresh request');
const controllerSource = await readFile(new URL('../editor/useEditorController.tsx', import.meta.url), 'utf8');
assert.match(controllerSource, /onRequestPasteTranscript: requestPasteTranscript/);
const previewSource = await readFile(new URL('../components/preview/PreviewWorkspace.tsx', import.meta.url), 'utf8');
assert.match(previewSource, /!textVisible && inspector/ , 'text mode disables inspector driven preview editing');
assert.match(previewSource, /\{inspector && <div className="cc-inspector-host"/, 'no inspector means no empty reserved column');
console.log('native project shortcuts and non-overlay external control verified');
} finally { await vite.close(); }
