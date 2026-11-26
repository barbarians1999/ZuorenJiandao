import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const source = await readFile(new URL('./ClipFx.tsx', import.meta.url), 'utf8');

assert.doesNotMatch(
  source,
  /import \{[^}]*\bVideo\b[^}]*\} from 'remotion'/,
  'effect preview must not reintroduce the HTML video decoder path',
);
assert.match(
  source,
  /<MediaVideo[\s\S]*onVideoFrame=\{onVideoFrame\}/,
  'effect preview must receive decoded frames from @remotion/media',
);
assert.doesNotMatch(
  source,
  /setRenderedKey\(renderKey\)/,
  'effect playback must not schedule a second React render for every decoded frame',
);

const server = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});

try {
  const { shouldShowClipFxCanvas } = await server.ssrLoadModule('/src/gl/ClipFx.tsx');

  assert.equal(
    shouldShowClipFxCanvas({
      hasRendered: false,
      privacyFailure: false,
      protectedSource: true,
      isRendering: false,
      renderedKey: null,
      renderKey: 'f1',
      renderedSurfaceKey: null,
      surfaceKey: 's1',
    }),
    false,
    'initial unrendered protected frame keeps black privacy shield',
  );
  assert.equal(
    shouldShowClipFxCanvas({
      hasRendered: true,
      privacyFailure: false,
      protectedSource: true,
      isRendering: false,
      renderedKey: 'f1',
      renderKey: 'f2',
      renderedSurfaceKey: 's1',
      surfaceKey: 's1',
    }),
    true,
    'playback frame advance on the same redacted surface must keep canvas visible instead of flashing black',
  );
  assert.equal(
    shouldShowClipFxCanvas({
      hasRendered: true,
      privacyFailure: false,
      protectedSource: true,
      isRendering: false,
      renderedKey: 'f1',
      renderKey: 'f2',
      renderedSurfaceKey: 's1',
      surfaceKey: 's2',
    }),
    false,
    'changing protected clip surface re-arms black privacy shield until redrawn',
  );
  assert.equal(
    shouldShowClipFxCanvas({
      hasRendered: true,
      privacyFailure: true,
      protectedSource: true,
      isRendering: false,
      renderedKey: 'f1',
      renderKey: 'f1',
      renderedSurfaceKey: 's1',
      surfaceKey: 's1',
    }),
    false,
    'privacy failure always hides canvas behind shield',
  );
  assert.equal(
    shouldShowClipFxCanvas({
      hasRendered: true,
      privacyFailure: false,
      protectedSource: true,
      isRendering: true,
      renderedKey: 'f1',
      renderKey: 'f2',
      renderedSurfaceKey: 's1',
      surfaceKey: 's1',
    }),
    false,
    'export rendering requires exact frame key match',
  );

  console.log('clipFxPreview.verify: GL preview uses shared @remotion/media decoder path and prevents playback black flicker');
} finally {
  await server.close();
}
