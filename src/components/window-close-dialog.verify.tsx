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

const componentSource = readFileSync(new URL('./WindowCloseConfirmDialog.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(componentSource, /#[0-9a-fA-F]{3,8}\b/, 'close dialog must use theme tokens instead of hex literals');

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
assert.match(appSource, /<WindowCloseConfirmDialog\s*\/>/, 'App mounts WindowCloseConfirmDialog on all routes');

console.log('window-close-dialog verification passed');
