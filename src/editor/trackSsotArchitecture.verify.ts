// Architecture guardrail: ensure runtime playback, export, and editor modules
// never re-introduce legacy virtual-transcript fields or import legacyTranscriptSegments.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'remotion', 'shared', 'server'];
const ALLOWED_MIGRATION_PREFIX = path.normalize('src/persist/migrations');
const FORBIDDEN_FIELDS = [
  'deletedWordIdx',
  'silenceFrames',
  'cutPadFrames',
  'gapCapsMs',
  'transcriptPlayOrder',
  '_keptSegments',
];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (/\.(ts|tsx|js|jsx|mjs|mts)$/.test(entry) && !/\.verify\.(ts|tsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir)));
const violations: string[] = [];

for (const absPath of files) {
  const rel = path.normalize(path.relative(ROOT, absPath));
  if (rel.startsWith(ALLOWED_MIGRATION_PREFIX)) continue;
  if (rel === path.normalize('src/transcript/trackEditCompiler.ts')) continue;
  const content = readFileSync(absPath, 'utf8');
  if (content.includes('legacyTranscriptSegments') || content.includes('transcript-kept-segments')) {
    violations.push(`${rel}: forbidden legacy transcript segment import`);
  }
  for (const field of FORBIDDEN_FIELDS) {
    // TimelineItem reads/writes of virtual-transcript timing fields are forbidden everywhere at runtime.
    // Compiler / UI action payloads may pass reconstructed unit.* or action.opts.* values.
    if (rel === path.normalize('src/editor/storeCommandBuilder.ts') && (field === 'silenceFrames' || field === 'gapCapsMs')) continue;
    if ((rel === path.normalize('src/agent/tools/transcript-tools.ts') || rel === path.normalize('src/script/serialize.ts'))
      && (field === 'deletedWordIdx' || field === 'gapCapsMs')) {
      if (!new RegExp(`\\b(item|it|c|clip|candidate|target)\\.${field}\\b`).test(content)) continue;
    }
    if (rel.startsWith(path.normalize('src/transcript/')) && (field === 'gapCapsMs' || field === 'silenceFrames')) {
      if (!new RegExp(`\\b(item|it|c|clip|candidate|target)\\.${field}\\b`).test(content)) continue;
    }
    if (new RegExp(`\\.${field}\\b|['"]${field}['"]`).test(content)) {
      violations.push(`${rel}: forbidden legacy virtual-transcript field "${field}"`);
    }
  }
}

assert.deepEqual(
  violations,
  [],
  `Track SSOT architecture guard violations:\n${violations.join('\n')}`,
);

console.log(`trackSsotArchitecture.verify: checked ${files.length} runtime files — 0 violations`);
