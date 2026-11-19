import assert from 'node:assert/strict';
import { browserExecutable, resolveRenderGlBackend, withAbortableCompositionSelection } from './render-browser.mjs';
import { withAbortableCompositionSelection as legacyInterface } from './render.mjs';
import { timelineStillOptions } from './render-contract.mjs';

assert.deepEqual(timelineStillOptions({ width: 1920, frameCount: 3 }), { scale: 1 / 3, jpegQuality: 72 });
assert.deepEqual(timelineStillOptions({ width: 1920, frameCount: 7 }), { scale: 1 / 4, jpegQuality: 72 });
for (const width of [320, 1080, 1920, 3840]) {
  assert.deepEqual(timelineStillOptions({ width, frameCount: 16, fullResolution: true }), { scale: 1, jpegQuality: 95 });
}
assert.throws(() => timelineStillOptions({ width: 1920, frameCount: 1, fullResolution: 'true' }), /boolean/);
assert.throws(() => timelineStillOptions({ width: 0, frameCount: 1 }), /positive/);

assert.equal(legacyInterface, withAbortableCompositionSelection, 'keep existing caller interface');
const oldGl = process.env.CC_RENDER_GL, oldBrowser = process.env.CC_BROWSER_EXECUTABLE;
try {
  process.env.CC_RENDER_GL = 'swangle'; assert.equal(resolveRenderGlBackend(), 'swangle');
  process.env.CC_RENDER_GL = 'null'; assert.equal(resolveRenderGlBackend(), null, 'browser default requires actual null, not a string');
  process.env.CC_RENDER_GL = 'invalid';
  assert.equal(resolveRenderGlBackend('win32'), 'swangle');
  assert.equal(resolveRenderGlBackend('linux'), 'angle-egl');
  assert.equal(resolveRenderGlBackend('darwin'), 'angle');
  process.env.CC_RENDER_GL = 'angle'; assert.equal(resolveRenderGlBackend('win32'), 'angle', 'explicit measured-host override is preserved');
  process.env.CC_BROWSER_EXECUTABLE = 'test-browser'; assert.equal(browserExecutable(), 'test-browser');
} finally {
  if (oldGl === undefined) delete process.env.CC_RENDER_GL; else process.env.CC_RENDER_GL = oldGl;
  if (oldBrowser === undefined) delete process.env.CC_BROWSER_EXECUTABLE; else process.env.CC_BROWSER_EXECUTABLE = oldBrowser;
}
for (const phase of ['success', 'select-error', 'render-error', 'abort-select', 'abort-open', 'pre-aborted']) {
  const controller = new AbortController();
  const reason = new Error(phase);
  let opens = 0, closes = 0, selections = 0, renders = 0;
  const browser = { close: async () => { closes++; } };
  if (phase === 'pre-aborted') controller.abort(reason);
  const attempt = () => withAbortableCompositionSelection({
    signal: controller.signal, selectionOptions: { id: 'timeline' },
    openBrowserImpl: async (type, options) => {
      opens++; assert.equal(type, 'chrome'); assert.equal(options.browserExecutable, browserExecutable());
      assert.equal(options.chromiumOptions.gl, resolveRenderGlBackend());
      if (phase === 'abort-open') controller.abort(reason); return browser;
    },
    selectCompositionImpl: async (options) => {
      selections++; assert.equal(options.puppeteerInstance, browser);
      assert.equal(options.mediaCacheSizeInBytes, 256 * 1024 ** 2, 'preparation has the same bounded browser cache as rendering');
      assert.ok(options.offthreadVideoCacheSizeInBytes <= 256 * 1024 ** 2, 'preparation does not start a default unbounded cache');
      if (phase === 'select-error') throw reason;
      if (phase === 'abort-select') controller.abort(reason);
      return { id: 'timeline' };
    },
    run: async (composition, instance) => {
      renders++; assert.equal(instance, browser); assert.equal(composition.id, 'timeline');
      if (phase === 'render-error') throw reason;
      return 'rendered';
    },
  });
  if (phase === 'success') assert.equal(await attempt(), 'rendered');
  else await assert.rejects(attempt, (error) => error === reason);
  assert.equal(opens, phase === 'pre-aborted' ? 0 : 1);
  assert.equal(closes, opens, 'close owned browser exactly once');
  assert.equal(renders, phase === 'success' || phase === 'render-error' ? 1 : 0);
  assert.equal(selections, phase === 'pre-aborted' || phase === 'abort-open' ? 0 : 1);
}
await withAbortableCompositionSelection({selectionOptions:{mediaCacheSizeInBytes:512*1024**2},
  openBrowserImpl:async()=>({close:async()=>{}}),
  selectCompositionImpl:async(options)=>{assert.equal(options.mediaCacheSizeInBytes,512*1024**2);return {};},run:async()=>{},
});
console.log('render-browser: unchanged interface, configuration, success, failure and cancellation ownership passed');
