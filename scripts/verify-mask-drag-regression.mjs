import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chapterSourceDigest } from './chapter-render-bundle.mjs';

const base = resolve('release/mask-drag-20261014'); await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'regression-'));
const checks = [
  'src/components/preview/previewMask.verify.tsx',
  'src/components/preview/previewTransform.verify.ts',
  'src/components/preview/preview-transform-overlay.verify.tsx',
  'src/editor/clipMask.verify.ts', 'src/editor/clipAnimation.verify.ts',
  'src/editor/mosaic.verify.ts', 'src/gl/fx/gaussianBlur.verify.ts',
  'src/components/inspector/MosaicControl.verify.tsx',
  'src/editor/compositionPlan.verify.ts', 'src/editor/historyGesture.verify.ts',
  'src/editor/reducerGuards.verify.ts', 'src/editor/transitionReconcile.verify.ts',
  'src/editor/split.verify.ts', 'src/persist/zuoren-project-roundtrip.verify.ts',
  'scripts/verify-registration.verify.mjs',
];
const report = { status: 'running', startedAt: new Date().toISOString(), checks: [], sourceDigest: await chapterSourceDigest(),
  scope: 'Typecheck and15 targeted regressions, not the complete standard suite.' };
const save = () => writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2));
for (const [index, check] of ['typecheck', ...checks].entries()) {
  const args = check === 'typecheck' ? ['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false']
    : check.endsWith('.mjs') ? [check] : ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.app.json', check];
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
  await writeFile(join(root, `${String(index).padStart(2, '0')}.log`), (result.stdout ?? '') + (result.stderr ?? '') + (result.error?.stack ?? ''));
  report.checks.push({ check, status: result.status === 0 && !result.error ? 'passed' : 'failed', exitCode: result.status,
    elapsedMs: performance.now() - started, error: result.error?.message });
  console.log(`${report.checks.at(-1).status}: ${check}`); await save();
  if (result.status !== 0 || result.error) { report.status = 'failed'; await save(); process.exitCode = 1; break; }
}
if (!process.exitCode) {
  if (report.sourceDigest !== await chapterSourceDigest()) throw new Error('Source changed during regression');
  report.status = 'passed'; report.finishedAt = new Date().toISOString(); await save();
}
console.log(`REPORT ${join(root, 'results.json')}`);
