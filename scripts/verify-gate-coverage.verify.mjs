// Coverage means every tracked and nonignored working-tree verifier has an
// explicit group, deadline, and a required scenario in the shared inventory.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { readInventory, projectFiles, validateInventory, selectItems } from './verification-inventory.mjs';

const root = process.cwd();
const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
const manifest = readInventory(root);
const project = projectFiles(root);
const counts = validateInventory(manifest, project);
assert(counts.files > 400, 'Expected the full verify corpus');
assert.equal(scripts.test, 'node scripts/run-tests.mjs');
assert.equal(scripts.pretest, undefined, 'Do not bypass per-item bounds with a pretest shell chain');
assert.equal(scripts.posttest, undefined, 'Heavy groups must not run implicitly after npm test');
assert.equal(scripts['test:serial'], 'node scripts/run-standard-verification.mjs --group=logic');
for (const group of Object.keys(manifest.groups)) {
  assert.equal(scripts[`test:${group}`], `node scripts/run-standard-verification.mjs --group=${group}`);
}
for (const suite of Object.keys(manifest.suites)) {
  if (suite === 'test:serial') continue;
  assert.equal(scripts[suite], `node scripts/run-standard-verification.mjs --suite=${suite}`, `Suite bypasses inventory: ${suite}`);
}
const defaultFiles = new Set(selectItems(manifest).map(item => item.file));
for (const file of ['scripts/verify-registration.verify.mjs', 'scripts/verify-gate-coverage.verify.mjs',
  'src/components/ProjectSaveIndicator.verify.tsx', 'src/components/audio/TrackAudioControl.verify.tsx',
  'src/components/inspector/InspectorAudioControls.verify.tsx', 'src/components/timeline/timelineAttachmentFeedback.verify.ts',
  'src/editor/animationAudition.verify.ts', 'src/editor/mediaSourceRange.verify.ts', 'src/editor/panel-divider-aria.verify.tsx',
  'src/editor/projectAutosaveQueue.verify.ts', 'src/editor/subdraftOperations.verify.ts', 'src/library/LibraryNavigation.verify.tsx',
  'src/media/MediaSourceRangePanel.verify.tsx', 'scripts/production-long-export-acceptance.verify.mjs']) {
  assert(defaultFiles.has(file), `Light regression missing from default logic: ${file}`);
}
for (const file of ['scripts/mask-blur-render.verify.mjs', 'scripts/mask-drag-render.verify.mjs', 'scripts/subdraft-render.verify.mjs']) {
  assert.equal(manifest.items.find(item => item.file === file)?.group, 'short-render');
}
for (const file of ['scripts/mask-blur-ui.verify.mjs', 'scripts/mask-drag-ui.verify.mjs']) {
  assert.equal(manifest.items.find(item => item.file === file)?.group, 'desktop');
}
assert(!selectItems(manifest).some(item => item.group !== 'logic'));

// Linux intentionally skips exact frame mapping. At least one required CI job
// must execute the existing render fixture on a platform that keeps it enabled.
const workflow = yaml.load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
assert.ok(Object.hasOwn(workflow.on, 'pull_request'), 'verification must run on pull requests');
const frameSync = workflow.jobs['frame-sync'];
assert.match(frameSync['runs-on'], /^macos-/);
assert.equal(frameSync.if, undefined, 'the render gate cannot be optional on PRs');
assert.equal(frameSync['continue-on-error'], undefined);
assert.ok(frameSync.steps.some((step) => /^actions\/checkout@/.test(step.uses ?? '')));
assert.ok(frameSync.steps.some((step) => step.run === 'npm ci --loglevel=error'));
assert.ok(frameSync.steps.some((step) => step.run === 'brew install ffmpeg'));
const renderStep = frameSync.steps.find((step) => step.run === 'node src/gl/clipFxExport.verify.mjs');
assert.ok(renderStep, 'macOS must run the complete effect and transition render fixture');
assert.equal(renderStep.if, undefined);
assert.equal(renderStep['continue-on-error'], undefined);

// AGENTS.md's 500-line source ceiling applies to new files too. Ask Git for
// tracked + nonignored untracked paths, excluding local generated scratch files.
const dataModules = new Set();
const sourceFiles = project.filter((file) => (
  /\.(?:tsx|mts|cjs|mjs|ts|js)$/.test(file)
  && !/\.(?:verify|check|test|spec)(?:[.-])|\.d\.ts$/.test(file)
  && !dataModules.has(file)
  && existsSync(join(root, file))
));
const oversizedSources = sourceFiles.flatMap((file) => {
  const source = readFileSync(join(root, file), 'utf8');
  const lines = source.split('\n').length - Number(source.endsWith('\n'));
  return lines > 500 ? [`${file}: ${lines} lines`] : [];
}).sort();
assert.deepEqual(oversizedSources, [],
  `Source files must stay at or below 500 lines. Split by responsibility:\n${oversizedSources.join('\n')}`);

console.log(`gate coverage checks passed (${counts.files} verify files, explicit grouped scenarios; workflow and source ceilings preserved)`);
