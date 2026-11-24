import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isDesktopClosePromptRequest,
  isDesktopClosePromptResponse,
} from '../shared/desktop-close-behavior.ts';
import { createMainWindowCloseController } from './window-close-controller.ts';

assert.equal(isDesktopClosePromptRequest({ requestId: 'req-1' }), true);
assert.equal(isDesktopClosePromptRequest({ requestId: '' }), false);
assert.equal(isDesktopClosePromptRequest({ requestId: 'req-1', extra: 1 }), false);

assert.equal(isDesktopClosePromptResponse({ requestId: 'req-1', action: 'background', remember: true }), true);
assert.equal(isDesktopClosePromptResponse({ requestId: 'req-1', action: 'quit', remember: false }), true);
assert.equal(isDesktopClosePromptResponse({ requestId: 'req-1', action: 'cancel', remember: false }), true);
assert.equal(isDesktopClosePromptResponse({ requestId: 'req-1', action: 'other', remember: false }), false);
assert.equal(isDesktopClosePromptResponse({ requestId: 'req-1', action: 'quit', remember: 'yes' }), false);

// 1. In-app prompt resolves background + remember without calling native dialog.
{
  let saved: string | undefined;
  let trayHidden = 0;
  let quitCalls = 0;
  let nativeCalls = 0;
  let sentRequestId = '';
  const controller = createMainWindowCloseController({
    getSavedBehavior: () => saved,
    saveBehavior: async (choice) => { saved = choice; },
    hideToTray: () => { trayHidden += 1; },
    quitApp: () => { quitCalls += 1; },
    isWindowDestroyed: () => false,
    isWindowMinimized: () => true,
    restoreWindow: () => undefined,
    showWindow: () => undefined,
    focusWindow: () => undefined,
    isRendererCrashed: () => false,
    sendPrompt: (req) => { sentRequestId = req.requestId; },
    showNativeDialog: async () => { nativeCalls += 1; return { choice: 'quit', remember: false }; },
    showErrorBox: () => { throw new Error('unexpected error box'); },
    nextRequestId: () => 'req-bg-1',
  });
  controller.setRendererPromptReady(true);

  let prevented = false;
  controller.handleWindowClose({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sentRequestId, 'req-bg-1');

  controller.handlePromptResponse({ requestId: 'req-bg-1', action: 'background', remember: true });
  await controller.waitForIdle();
  assert.equal(nativeCalls, 0);
  assert.equal(trayHidden, 1);
  assert.equal(quitCalls, 0);
  assert.equal(saved, 'background');
}

// 2. Cancel does not save remember or quit/hide.
{
  let saved: string | undefined;
  let trayHidden = 0;
  let quitCalls = 0;
  const controller = createMainWindowCloseController({
    getSavedBehavior: () => saved,
    saveBehavior: async (choice) => { saved = choice; },
    hideToTray: () => { trayHidden += 1; },
    quitApp: () => { quitCalls += 1; },
    isWindowDestroyed: () => false,
    isWindowMinimized: () => false,
    restoreWindow: () => undefined,
    showWindow: () => undefined,
    focusWindow: () => undefined,
    isRendererCrashed: () => false,
    sendPrompt: () => undefined,
    showNativeDialog: async () => ({ choice: 'quit', remember: false }),
    showErrorBox: () => { throw new Error('unexpected error box'); },
    nextRequestId: () => 'req-cancel',
  });
  controller.setRendererPromptReady(true);
  controller.handleWindowClose({ preventDefault: () => undefined });
  controller.handlePromptResponse({ requestId: 'req-cancel', action: 'cancel', remember: true });
  await controller.waitForIdle();
  assert.equal(saved, undefined);
  assert.equal(trayHidden, 0);
  assert.equal(quitCalls, 0);
}

// 3. Falls back to native dialog when renderer prompt is not ready or crashed.
{
  let nativeCalls = 0;
  let quitCalls = 0;
  const controller = createMainWindowCloseController({
    getSavedBehavior: () => undefined,
    saveBehavior: async () => undefined,
    hideToTray: () => undefined,
    quitApp: () => { quitCalls += 1; },
    isWindowDestroyed: () => false,
    isWindowMinimized: () => false,
    restoreWindow: () => undefined,
    showWindow: () => undefined,
    focusWindow: () => undefined,
    isRendererCrashed: () => false,
    sendPrompt: () => { throw new Error('must not send when not ready'); },
    showNativeDialog: async () => { nativeCalls += 1; return { choice: 'quit', remember: false }; },
    showErrorBox: () => { throw new Error('unexpected error box'); },
  });
  controller.handleWindowClose({ preventDefault: () => undefined });
  await controller.waitForIdle();
  assert.equal(nativeCalls, 1);
  assert.equal(quitCalls, 1);
}

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
assert.match(mainSource, /installMainWindowCloseBehavior\(win,.*origin\)/, 'main passes trusted origin to close behavior');

console.log('desktop window-close verification passed');
