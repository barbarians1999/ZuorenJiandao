import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computeTooltipPosition } from './tooltipPosition';

// 1. Default below placement (start-aligned)
{
  const result = computeTooltipPosition({
    anchor: { left: 100, top: 40, right: 136, bottom: 76, width: 36, height: 36 },
    tooltip: { width: 120, height: 28 },
    viewport: { width: 1280, height: 800 },
  });
  assert.deepEqual(result, { left: 100, top: 83, placement: 'bottom' });
}

// 2. Right-aligned placement (end-aligned, e.g. .cc-tip-r)
{
  const result = computeTooltipPosition({
    anchor: { left: 1180, top: 40, right: 1216, bottom: 76, width: 36, height: 36 },
    tooltip: { width: 140, height: 28 },
    viewport: { width: 1280, height: 800 },
    preferredAlign: 'end',
  });
  assert.deepEqual(result, { left: 1076, top: 83, placement: 'bottom' });
}

// 3. Auto flip to top when anchor is near bottom edge (e.g. PreviewMonitorBar or bottom-edge icons)
{
  const result = computeTooltipPosition({
    anchor: { left: 400, top: 750, right: 430, bottom: 780, width: 30, height: 30 },
    tooltip: { width: 150, height: 32 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'bottom',
  });
  assert.deepEqual(result, { left: 400, top: 711, placement: 'top' });
}

// 4. Preferred top placement (e.g. .cc-tip-up in chat scroll-to-bottom) and auto flip to bottom near top edge
{
  const normalTop = computeTooltipPosition({
    anchor: { left: 900, top: 680, right: 928, bottom: 706, width: 28, height: 26 },
    tooltip: { width: 96, height: 28 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'top',
  });
  assert.deepEqual(normalTop, { left: 900, top: 645, placement: 'top' });

  const flippedBottom = computeTooltipPosition({
    anchor: { left: 900, top: 10, right: 928, bottom: 36, width: 28, height: 26 },
    tooltip: { width: 96, height: 28 },
    viewport: { width: 1280, height: 800 },
    preferredPlacement: 'top',
  });
  assert.deepEqual(flippedBottom, { left: 900, top: 43, placement: 'bottom' });
}

// 5. Left and right viewport clamping so long tooltip text never clips off-screen
{
  const clampedRight = computeTooltipPosition({
    anchor: { left: 1230, top: 100, right: 1266, bottom: 136, width: 36, height: 36 },
    tooltip: { width: 240, height: 28 },
    viewport: { width: 1280, height: 800 },
    preferredAlign: 'start',
  });
  assert.deepEqual(clampedRight, { left: 1032, top: 143, placement: 'bottom' });

  const clampedLeft = computeTooltipPosition({
    anchor: { left: 10, top: 100, right: 46, bottom: 136, width: 36, height: 36 },
    tooltip: { width: 240, height: 28 },
    viewport: { width: 1280, height: 800 },
    preferredAlign: 'end',
  });
  assert.deepEqual(clampedLeft, { left: 8, top: 143, placement: 'bottom' });
}

// 6. Source & CSS contract assertions
const [mainSource, hostSource, cssSource] = await Promise.all([
  readFile(new URL('../main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('./TooltipHost.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../index.css', import.meta.url), 'utf8'),
]);

assert.match(mainSource, /<TooltipHost\s*\/>/, 'src/main.tsx must mount <TooltipHost />');
assert.match(hostSource, /setAttribute\(['"]popover['"],\s*['"]hint['"]\)/, 'TooltipHost must use popover="hint"');
assert.match(hostSource, /showPopover/, 'TooltipHost must promote tooltip to Top Layer via showPopover');
assert.match(hostSource, /hidePopover/, 'TooltipHost must close tooltip via hidePopover');
assert.match(hostSource, /:disabled/, 'TooltipHost must handle disabled .cc-tip buttons');
assert.match(hostSource, /aria-expanded/, 'TooltipHost must suppress tooltip when aria-expanded="true"');
assert.match(hostSource, /\.cc-utilities-popover/, 'TooltipHost must suppress tooltip inside .cc-utilities-popover');
assert.match(hostSource, /\.cc-popover-anchor/, 'TooltipHost must suppress tooltip when .cc-popover-anchor has open popover');
assert.match(hostSource, /details.*hasAttribute\(['"]open['"]\)/, 'TooltipHost must suppress tooltip on open details');
assert.match(hostSource, /['"]Escape['"]/, 'TooltipHost must dismiss tooltip on Escape');
assert.match(hostSource, /fullscreenElement/, 'TooltipHost must follow fullscreenElement');

assert.match(
  cssSource,
  /\.cc-tooltip-layer\s*\{[^}]*inset:\s*auto;\s*margin:\s*0;/s,
  'index.css must override UA popover centering with inset:auto; margin:0;',
);
assert.match(
  cssSource,
  /html\[data-cc-tooltip-host="ready"\]\s+\.cc-tip::after\s*\{\s*display:\s*none\s*!important;\s*\}/,
  'index.css must suppress legacy ::after once TooltipHost is mounted',
);
assert.match(
  cssSource,
  /\.cc-tip-up::after\s*\{[^}]*bottom:\s*calc\(100%\s*\+\s*7px\)/,
  'index.css must support .cc-tip-up::after fallback',
);

console.log('tooltipLayer.verify: geometry, Top-Layer host, and CSS contracts OK');
