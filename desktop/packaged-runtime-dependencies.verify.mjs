import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  packagedDependencyProblems, packagedProductAssetProblems, REQUIRED_PACKAGED_PRODUCT_ASSETS,
  runtimePackageName, verifyPackagedProductAssets, verifyRuntimeDependencyDeclarations,
} from './packaged-runtime-dependencies.mjs';

assert.equal(runtimePackageName('node:fs'), null);
assert.equal(runtimePackageName('fs/promises'), null);
assert.equal(runtimePackageName('electron'), null);
assert.equal(runtimePackageName('./app-main.mjs'), null);
assert.equal(runtimePackageName('@modelcontextprotocol/sdk/server/index.js'), '@modelcontextprotocol/sdk');
const declared = { dependencies: { undici: '7.29.1' } };
assert.deepEqual(packagedDependencyProblems(['undici'], declared, ['\\node_modules\\undici\\package.json']), []);
assert.deepEqual(packagedDependencyProblems(['undici'], declared, ['/node_modules/undici/package.json']), []);
assert.match(packagedDependencyProblems(['undici'], declared, [])[0], /missing from app.asar/);
assert.match(packagedDependencyProblems(['undici'], { devDependencies: { undici: '7.29.1' } }, ['/node_modules/undici/package.json'])[0], /production dependencies/);
assert.match(packagedDependencyProblems(['undici'], declared, ['/node_modules/another/node_modules/undici/package.json'])[0], /missing from app.asar/);
const packages = verifyRuntimeDependencyDeclarations();
assert.ok(packages.includes('undici'));
assert.ok(!packages.includes('@remotion/bundler'));
assert.ok(!packages.includes('@mediapipe/tasks-vision'));
const config = readFileSync(new URL('../config/electron-builder.config.mjs', import.meta.url), 'utf8');
assert.match(config, /afterPack\(context\)/);
assert.match(config, /verifyPackagedRuntimeDependencies\(join\(resources, 'app.asar'\)\)/);
assert.match(config, /verifyPackagedProductAssets\(resources\)/);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'packaged-assets-check-'));
try {
  assert.ok(packagedProductAssetProblems(fixtureRoot).some((entry) => entry.endsWith('noto-sans-sc.css')));
  assert.throws(() => verifyPackagedProductAssets(fixtureRoot), /Packaged product asset check failed/);
  for (const relPath of REQUIRED_PACKAGED_PRODUCT_ASSETS) {
    const full = join(fixtureRoot, relPath);
    if (relPath.includes('.')) {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    } else {
      mkdirSync(full, { recursive: true });
    }
  }
  assert.deepEqual(packagedProductAssetProblems(fixtureRoot), []);
  assert.equal(verifyPackagedProductAssets(fixtureRoot).length, REQUIRED_PACKAGED_PRODUCT_ASSETS.length);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
console.log(`packaged runtime dependency regression checks passed (${packages.length} packages)`);
