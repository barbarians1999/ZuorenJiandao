import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { WindowCloseConfirmModal } from './WindowCloseConfirmDialog';

const closedHtml = renderToStaticMarkup(
  <WindowCloseConfirmModal
    open={false}
    remember={false}
    onRememberChange={() => undefined}
    onAction={() => undefined}
  />,
);
assert.equal(closedHtml, '');

const openHtml = renderToStaticMarkup(
  <WindowCloseConfirmModal
    open={true}
    remember={true}
    onRememberChange={() => undefined}
    onAction={() => undefined}
  />,
);

assert.match(openHtml, /role="dialog"/);
assert.match(openHtml, /aria-modal="true"/);
assert.match(openHtml, /关闭左人剪刀/);
assert.match(openHtml, /关闭窗口后，左人剪刀要继续运行吗？/);
assert.match(openHtml, /隐藏后，可以从系统托盘重新打开窗口。/);
assert.match(openHtml, /下次不再提醒/);
assert.match(openHtml, /彻底关闭/);
assert.match(openHtml, /隐藏后台/);
assert.match(openHtml, /取消/);
assert.match(openHtml, /checked=""/);
assert.match(openHtml, /cc-window-close-backdrop/);
assert.match(openHtml, /cc-window-close-dialog/);
assert.match(openHtml, /cc-window-close-x/);
assert.match(openHtml, /cc-window-close-checkbox/);
assert.match(openHtml, /cc-window-close-cancel/);
assert.match(openHtml, /cc-window-close-danger/);
assert.match(openHtml, /cc-window-close-primary/);

const componentSource = readFileSync(new URL('./WindowCloseConfirmDialog.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(componentSource, /#[0-9a-fA-F]{3,8}\b/, 'close dialog must use theme tokens instead of hex literals');

const skinCss = readFileSync(new URL('../skin-themes.css', import.meta.url), 'utf8');
assert.match(
  skinCss,
  /html\[data-cc-skin-family='constructivism'\][\s\S]*?\.cc-window-close-dialog[\s\S]*?border-radius:\s*0\s*!important/,
  'constructivism theme must enforce 0px square radius on WindowCloseConfirmDialog',
);
assert.match(
  skinCss,
  /html\[data-cc-skin-family='constructivism'\]\s*\.cc-window-close-dialog\s+\.cc-window-close-checkbox[\s\S]*?border-radius:\s*0\s*!important/,
  'constructivism theme must style the close dialog checkbox as a square',
);

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /<WindowCloseConfirmDialog\s*\/>/, 'App mounts WindowCloseConfirmDialog on all routes');

const polishCss = readFileSync(new URL('../editor/editor-ui-polish.css', import.meta.url), 'utf8');
assert.doesNotMatch(
  skinCss,
  /html\[data-cc-skin-family='liquid-glass'\][\s\S]*?\.cc-timeline-tool-group\s*\{[^}]*backdrop-filter:/,
  'liquid-glass must not put backdrop-filter on .cc-timeline-tool-group so video tracks never cover toolbar controls',
);
assert.doesNotMatch(
  skinCss,
  /html\[data-cc-skin-family='liquid-glass'\][\s\S]*?\.cc-right-panel-shell\s*\{[^}]*backdrop-filter:/,
  'liquid-glass must not trap fixed popovers inside .cc-right-panel-shell backdrop-filter',
);
assert.doesNotMatch(
  skinCss,
  /html\[data-cc-skin-family='liquid-glass'\][\s\S]*?\.cc-topbar,\s*[\s\S]*?\.cc-dashboard-titlebar\s*\{[^}]*backdrop-filter:/,
  'liquid-glass must not put backdrop-filter on .cc-topbar',
);
assert.doesNotMatch(
  skinCss,
  /\.cc-timeline-clip\.is-selected\s*\{[^}]*filter:/,
  'liquid-glass selected clips must not create filter stacking layers over sticky track-head buttons',
);
assert.match(
  polishCss,
  /\.cc-editor-shell\s+\.cc-timeline-toolbar\s*\{[^}]*z-index:\s*35;/s,
  'timeline toolbar must stack above ruler, playhead, and sticky track headers',
);

console.log('window-close-dialog verification passed');
