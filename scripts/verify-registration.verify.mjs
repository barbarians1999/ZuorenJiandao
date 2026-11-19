import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readInventory, projectFiles, validateInventory, verifyPattern } from './verification-inventory.mjs';

const root = process.cwd(), files = projectFiles(root);
const counts = validateInventory(readInventory(root), files);
assert(counts.files > 400, 'Expected the full verification corpus');
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
const untracked = files.filter(file => verifyPattern.test(file) && !tracked.has(file));
if (process.env.CI) assert.deepEqual(untracked, [], `CI requires registered files to be tracked:\n${untracked.join('\n')}`);
else if (untracked.length) console.log(`${untracked.length} registered working-tree verifies still require inclusion in the eventual commit.`);
console.log(`verify-registration: ${counts.files} tracked and nonignored working-tree verifies registered in one manifest`);
