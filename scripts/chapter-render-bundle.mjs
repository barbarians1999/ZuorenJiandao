import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile, access, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const manifestName = 'chapter-source-provenance.json';

// Scope the cache to product sources, static assets and dependency/config
// declarations. Stream sequentially: provenance must not add a large RAM spike.
export async function chapterSourceDigest(root = resolve('.')) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Cannot fingerprint linked source: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && !/\.verify\.(ts|tsx|mjs)$/.test(file)) {
        hash.update(file + '\0');
        for await (const chunk of createReadStream(join(root, file))) hash.update(chunk);
        hash.update('\0');
      }
    }
  }
  for (const directory of ['src', 'remotion', 'shared', 'assets', 'config']) await visit(directory);
  for (const entry of (await readdir(root)).sort()) {
    if (/^(package(?:-lock)?\.json|pnpm-lock\.yaml|tsconfig.*\.json)$/.test(entry)) {
      hash.update(entry + '\0'); hash.update(await readFile(join(root, entry))); hash.update('\0');
    }
  }
  return hash.digest('hex');
}

export function validateChapterBundle(manifest, digest) {
  assert.equal(manifest.version, 1, 'Bundle has no recognised source provenance; build a fresh bundle');
  assert.equal(manifest.sourceDigest, digest, 'Render sources changed; do not accept an old bundle');
}

export async function prepareChapterBundle({ output, reuse, build, signal, existingOnly = false }) {
  signal.throwIfAborted();
  const sourceDigest = await chapterSourceDigest();
  signal.throwIfAborted();
  if (!reuse && !existingOnly && output) {
    // Reuse only a fingerprinted current build; give each run its own mutable upload binding.
    const candidate = resolve('desktop-dist/remotion-bundle');
    let current = false;
    try { validateChapterBundle(JSON.parse(await readFile(join(candidate, manifestName), 'utf8')), sourceDigest);
      await access(join(candidate, 'index.html')); current = true;
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof assert.AssertionError)) throw error; }
    if (current) {
      signal.throwIfAborted();
      await cp(candidate, output, { recursive: true, dereference: false,
        filter: (path) => !/(?:^|[\\/])media[\\/]uploads(?:[\\/]|$)/.test(path) });
      return { directory: resolve(output), sourceDigest, reused: true, clonedFrom: candidate };
    }
  }
  if (!reuse && existingOnly) {
    // Only the protected full verifier creates bundles. The tiny companion
    // must not start an uncancellable webpack build in this process.
    const release = resolve('release');
    const entries = await readdir(release, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('chapter-animation-')) continue;
      const candidate = join(release, entry.name, 'serve');
      try {
        validateChapterBundle(JSON.parse(await readFile(join(candidate, manifestName), 'utf8')), sourceDigest);
        await access(join(candidate, 'index.html'));
        reuse = candidate; break;
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof assert.AssertionError)) throw error;
      }
      signal.throwIfAborted();
    }
    assert.ok(reuse, 'No matching protected test bundle; run the full chapter verifier with sufficient RAM first');
  }
  if (reuse) {
    const directory = resolve(reuse);
    validateChapterBundle(JSON.parse(await readFile(join(directory, manifestName), 'utf8')), sourceDigest);
    await access(join(directory, 'index.html'));
    return { directory, sourceDigest, reused: true };
  }
  assert.equal(typeof build, 'function', 'A fresh bundle needs the protected full verifier');
  const directory = await build(output);
  signal.throwIfAborted();
  assert.equal(await chapterSourceDigest(), sourceDigest, 'Source changed during bundling; discard this test result');
  await writeFile(join(directory, manifestName), JSON.stringify({ version: 1, sourceDigest, builtAt: new Date().toISOString() }, null, 2));
  return { directory, sourceDigest, reused: false };
}
