import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chapterSourceDigest } from './chapter-render-bundle.mjs';

// A durable report runner for short serial checks only; never a long pipeline.
const checks = [
  'desktop/font-sfnt.verify.ts', 'desktop/font-library.verify.ts', 'src/fonts/fontWorkflow.verify.ts',
  'src/audio/soundWorkflow.verify.ts', 'src/library/sound-localization.verify.ts',
  'src/captions/captionList.verify.ts', 'src/captions/captionListPanel.verify.tsx',
  'src/captions/pastedTranscriptPanel.verify.tsx', 'src/captions/pastedTranscriptWorkflow.verify.ts',
  'src/captions/manualCaptions.verify.ts', 'src/captions/captionSelection.verify.ts',
  'src/captions/renderStyles.verify.ts', 'src/captions/exportCaptions.verify.ts',
  'src/scene-detection/workflow.verify.ts', 'server/plugins/scene-detection.verify.ts',
  'src/agent/tools/scene-detection-tools.verify.ts',
  'src/components/inspector/PictureAnimationControl.verify.tsx',
  'src/components/timeline/TimelineToolbar.verify.tsx',
  'src/components/timeline/libraryDropActions.verify.ts',
  'src/editor/clipAnimation.verify.ts', 'src/editor/animationAudition.verify.ts',
  'src/editor/storeCommandBuilder.verify.ts', 'src/editor/reducerGuards.verify.ts',
  'src/editor/historyGesture.verify.ts', 'src/editor/split.verify.ts',
  'src/editor/transitionReconcile.verify.ts', 'src/editor/textStyles.verify.ts',
  'src/editor/audioRouting.verify.ts', 'src/persist/zuoren-project-roundtrip.verify.ts',
  'remotion/direct-cut.verify.mjs', 'remotion/direct-hardware.verify.mjs', 'remotion/performance.verify.mjs',
];
const output = resolve(process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
  ?? `release/jianying-workflow-20261013/checks-${Date.now()}`);
mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), node: process.execPath,
  sourceDigest: await chapterSourceDigest(), checks: [], status: 'running' };
const save = () => writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2));
save();
for (const file of checks) {
  const started = Date.now();
  const args = file.endsWith('.mjs') ? [file]
    : ['node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.app.json', file];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true,
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(output, `${file.replace(/[/\\]/g, '_')}.log`), log);
  const passed = !result.error && result.status === 0;
  report.checks.push({ file, passed, milliseconds: Date.now() - started, status: result.status,
    signal: result.signal, error: result.error?.message });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${file} (${Date.now() - started} ms)`);
  if (!passed) console.error(log);
  save();
}
report.status = report.checks.every((entry) => entry.passed) ? 'passed' : 'failed';
if (report.sourceDigest !== await chapterSourceDigest()) {
  report.status = 'failed'; report.error = 'Product sources changed during the checks';
}
report.finishedAt = new Date().toISOString(); save();
console.log(`Short workflow regression: ${report.checks.filter((entry) => entry.passed).length}/${checks.length}; ${output}`);
process.exitCode = report.status === 'passed' ? 0 : 1;
