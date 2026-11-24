import { randomUUID } from 'node:crypto';
import {
  isDesktopClosePromptResponse,
  type DesktopClosePromptRequest,
} from '../shared/desktop-close-behavior.ts';

export interface CloseChoiceResult {
  choice: 'quit' | 'background' | null;
  remember: boolean;
}

export interface MainWindowCloseControllerDeps {
  getSavedBehavior: () => unknown;
  saveBehavior: (choice: 'quit' | 'background') => Promise<void>;
  hideToTray: () => void;
  quitApp: () => void;
  isWindowDestroyed: () => boolean;
  isWindowMinimized: () => boolean;
  restoreWindow: () => void;
  showWindow: () => void;
  focusWindow: () => void;
  isRendererCrashed: () => boolean;
  sendPrompt: (request: DesktopClosePromptRequest) => void;
  showNativeDialog: () => Promise<CloseChoiceResult>;
  showErrorBox: (title: string, content: string) => void;
  nextRequestId?: () => string;
}

export function createMainWindowCloseController(deps: MainWindowCloseControllerDeps) {
  let pending = false;
  let quitting = false;
  let rendererPromptReady = false;
  let activePrompt: { requestId: string; resolve: (value: CloseChoiceResult) => void } | null = null;
  let activeTask: Promise<void> = Promise.resolve();

  function settlePrompt(result: CloseChoiceResult = { choice: null, remember: false }): void {
    if (!activePrompt) return;
    const current = activePrompt;
    activePrompt = null;
    current.resolve(result);
  }

  function setRendererPromptReady(ready: boolean): void {
    rendererPromptReady = ready;
    if (!ready) settlePrompt();
  }

  function handlePromptResponse(value: unknown): void {
    if (!isDesktopClosePromptResponse(value)) {
      throw new Error('invalid window close response');
    }
    if (activePrompt && activePrompt.requestId === value.requestId) {
      const current = activePrompt;
      activePrompt = null;
      current.resolve({
        choice: value.action === 'cancel' ? null : value.action,
        remember: value.action === 'cancel' ? false : value.remember,
      });
    }
  }

  async function promptCloseChoice(): Promise<CloseChoiceResult> {
    if (rendererPromptReady && !deps.isWindowDestroyed() && !deps.isRendererCrashed()) {
      if (deps.isWindowMinimized()) deps.restoreWindow();
      deps.showWindow();
      deps.focusWindow();
      const requestId = deps.nextRequestId ? deps.nextRequestId() : randomUUID();
      return new Promise<CloseChoiceResult>((resolve) => {
        activePrompt = { requestId, resolve };
        try {
          deps.sendPrompt({ requestId });
        } catch (error) {
          if (activePrompt?.requestId === requestId) activePrompt = null;
          throw error;
        }
      }).catch(async () => {
        if (quitting || deps.isWindowDestroyed()) return { choice: null, remember: false };
        return deps.showNativeDialog();
      });
    }
    return deps.showNativeDialog();
  }

  async function closeOrHide(): Promise<void> {
    const saved = deps.getSavedBehavior();
    let choice: 'quit' | 'background' | null = saved === 'quit' || saved === 'background' ? saved : null;
    let remember = false;
    if (!choice) {
      const prompted = await promptCloseChoice();
      choice = prompted.choice;
      remember = prompted.remember;
    }
    if (!choice || quitting || deps.isWindowDestroyed()) return;
    if (choice === 'background') deps.hideToTray();
    if (remember) {
      await deps.saveBehavior(choice).catch((error: unknown) => {
        console.warn('[desktop] could not remember close behavior:', error);
      });
    }
    if (choice === 'quit' && !quitting && !deps.isWindowDestroyed()) deps.quitApp();
  }

  function handleWindowClose(event: { preventDefault: () => void }): void {
    if (quitting) return;
    event.preventDefault();
    if (pending) {
      if (!deps.isWindowDestroyed()) {
        if (deps.isWindowMinimized()) deps.restoreWindow();
        deps.focusWindow();
      }
      return;
    }
    pending = true;
    activeTask = closeOrHide().catch((error: unknown) => {
      console.warn('[desktop] close behavior failed:', error);
      if (!quitting && !deps.isWindowDestroyed()) {
        deps.showErrorBox('左人剪刀', '无法完成关闭操作，请重试。');
      }
    }).finally(() => { pending = false; });
  }

  return {
    handleWindowClose,
    handlePromptResponse,
    setRendererPromptReady,
    markQuitting: () => { quitting = true; settlePrompt(); },
    resetQuitting: () => { quitting = false; },
    dispose: () => { rendererPromptReady = false; settlePrompt(); },
    waitForIdle: () => activeTask,
    isRendererPromptReady: () => rendererPromptReady,
  };
}
