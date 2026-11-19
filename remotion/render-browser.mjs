import { openBrowser, selectComposition } from '@remotion/renderer';
import { resolveRenderMemorySettings } from './performance.mjs';

export const browserExecutable = () => process.env.CC_BROWSER_EXECUTABLE || undefined;

// Shared by movie and still rendering. Keep environment-specific browser
// ownership and cancellation here, separate from bundling and media encoding.
const RENDER_GL_OVERRIDES = new Set(['angle', 'angle-egl', 'egl', 'vulkan', 'swangle', 'null']);
export function resolveRenderGlBackend(platform = process.platform) {
  const override = process.env.CC_RENDER_GL;
  // CLI/environment values are strings; Remotion expects actual null to omit
  // GL switches. Passing the string "null" is not the default-browser backend.
  if (override && RENDER_GL_OVERRIDES.has(override)) return override === 'null' ? null : override;
  // Compatibility exports must not depend on Windows display-driver recovery.
  // Software GL changes compositing, not the selected H.264 encoder or UI preview.
  // An explicit ANGLE override remains available for measured, driver-safe hosts.
  if (platform === 'win32') return 'swangle';
  return platform === 'linux' ? 'angle-egl' : 'angle';
}

/** Own one browser across selection and rendering; close it once, including
 * cancellation during selection. Tests substitute the existing renderer seam. */
export async function withAbortableCompositionSelection({
  signal,
  selectionOptions,
  run,
  openBrowserImpl = openBrowser,
  selectCompositionImpl = selectComposition,
}) {
  signal?.throwIfAborted();
  const browser = await openBrowserImpl('chrome', {
    browserExecutable: browserExecutable(),
    chromiumOptions: { gl: resolveRenderGlBackend() },
  });
  let closePromise;
  const closeBrowser = () => closePromise ??= Promise.resolve(browser.close({ silent: true })).catch(() => undefined);
  const onAbort = () => { void closeBrowser(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const composition = await selectCompositionImpl({ ...resolveRenderMemorySettings(), ...selectionOptions, puppeteerInstance: browser });
    signal?.throwIfAborted();
    return await run(composition, browser);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await closeBrowser();
  }
}
