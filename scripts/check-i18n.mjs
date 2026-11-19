import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictRoot = path.join(root, 'src', 'i18n', 'dict');
const localeFiles = fs.readdirSync(dictRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(localeFiles, ['zh'], 'only the Chinese UI dictionary may remain');

const locale = fs.readFileSync(path.join(root, 'src', 'i18n', 'locale.ts'), 'utf8');
assert.match(locale, /export type Locale = 'zh'/, 'the runtime locale is pinned to Chinese');
assert.doesNotMatch(locale, /ALL_LOCALES|setLocale\s*\(/, 'locale switching is removed');
const sourceRoots = ['src', 'desktop', 'server'];
const violations = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (/\.(?:tsx?|mjs)$/.test(entry.name)) {
      const text = fs.readFileSync(fullPath, 'utf8');
      if (/i18n\/dict\/(?:en|it|ru)(?:\/|['"])/.test(text)) {
        violations.push(path.relative(root, fullPath));
      }
      if (/\b(?:LocaleToggle|setLocale)\b/.test(text)) {
        violations.push(path.relative(root, fullPath));
      }
    }
  }
}
for (const dir of sourceRoots) {
  const fullPath = path.join(root, dir);
  if (fs.existsSync(fullPath)) walk(fullPath);
}
assert.deepEqual([...new Set(violations)], [], 'no removed locale resources or switch controls may be referenced');
console.log('Chinese-only locale check passed.');
