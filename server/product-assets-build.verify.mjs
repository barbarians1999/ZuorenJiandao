import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { PRODUCT_ASSETS_DIR, productAssetsPlugin } from './product-assets.ts';

const root = mkdtempSync(join(tmpdir(), 'product-assets-build-'));
try {
  const asset = 'fonts/noto-sans-sc/noto-sans-sc.css';
  const outDir = join(root, 'custom-output');
  mkdirSync(join(root, 'input'));
  writeFileSync(join(root, 'input', 'index.html'), '<!doctype html><title>test</title>');
  await build({ configFile: false, root: join(root, 'input'), plugins: [productAssetsPlugin()],
    logLevel: 'silent', build: { outDir, emptyOutDir: true } });
  assert.deepEqual(readFileSync(join(outDir, asset)), readFileSync(join(PRODUCT_ASSETS_DIR, asset)));
  console.log('product assets copied into custom Vite output');
} finally {
  rmSync(root, { recursive: true, force: true });
}
