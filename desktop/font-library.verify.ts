import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopFontLibrary } from './font-library.ts';
import { fontCollectionFixture, fontFixture } from './font-test-fixture.ts';
import { fontAssetMetadata } from '../shared/desktop-fonts.ts';

const directory = await mkdtemp(join(tmpdir(), 'zuoren-font-check-'));
try {
  const file = join(directory, 'font.ttc'), broken = join(directory, 'broken.ttf');
  const firstBatchFile = join(directory, 'batch-a.ttf');
  const secondBatchFile = join(directory, 'batch-b.ttf');
  await writeFile(file, fontCollectionFixture([fontFixture('第一种'), fontFixture('第二种', 700)]));
  await writeFile(firstBatchFile, fontFixture('字体甲'));
  await writeFile(secondBatchFile, fontFixture('字体乙'));
  await writeFile(broken, 'not a font');
  const library = createDesktopFontLibrary({ systemPaths: async () => [file, broken], directory: () => directory });
  const catalog = await library.listSystemFonts();
  assert.equal(catalog.faces.length, 2); assert.equal(catalog.unreadableFiles, 1);
  assert.equal(catalog.faces[0]?.filename, 'font.ttc');
  assert.ok(catalog.faces.every((face) => !JSON.stringify(face).includes(directory)));
  const face = catalog.faces.find((entry) => entry.family === '第二种')!;
  const first = await library.materializeFont(face.faceId), second = await library.materializeFont(face.faceId);
  assert.equal(first.id, second.id, 'repeat imports deduplicate the exact face bytes');
  assert.ok((await Promise.all(Array.from({ length: 12 }, () => library.materializeFont(face.faceId)))).every((asset) => asset.id === first.id));
  assert.equal(first.kind, 'file'); assert.equal(fontAssetMetadata(first)?.family, '第二种');
  const stored = await readFile(join(directory, first.src.split('/').at(-1)!));
  assert.equal(createHash('sha256').update(stored).digest('hex'), first.sourceContentHash);
  assert.equal(stored.subarray(0, 4).equals(Buffer.from('ttcf')), false, 'only the selected standalone face is stored');
  await assert.rejects(library.materializeFont('C:\\Windows\\Fonts\\arial.ttf'), /失效/);

  // Batch & sequential imports accumulate across projects and survive library re-instantiation
  const batch1 = await library.importFontFiles([firstBatchFile, broken]);
  assert.equal(batch1.imported.length, 1);
  assert.equal(batch1.failed, 1);
  assert.equal(batch1.assets.length, 1);
  assert.equal(fontAssetMetadata(batch1.assets[0])?.family, '字体甲');

  const batch2 = await library.importFontFiles([secondBatchFile]);
  assert.equal(batch2.imported.length, 1);
  assert.equal(batch2.failed, 0);
  assert.equal(batch2.assets.length, 2, 'subsequent import preserves previously imported fonts');
  assert.deepEqual(
    batch2.assets.map((asset) => fontAssetMetadata(asset)?.family),
    ['字体乙', '字体甲'],
  );

  // Re-importing an existing font deduplicates cleanly without losing others
  const deduped = await library.importFontFiles([firstBatchFile]);
  assert.equal(deduped.assets.length, 2);

  // Fresh instance (simulating app restart / another project) reads all persisted imported fonts
  const reloadedLibrary = createDesktopFontLibrary({ systemPaths: async () => [], directory: () => directory });
  const persisted = await reloadedLibrary.listImportedFonts();
  assert.equal(persisted.length, 2);
  assert.deepEqual(
    persisted.map((asset) => fontAssetMetadata(asset)?.family),
    ['字体甲', '字体乙'],
  );

  // Deleting one backing font file drops only the missing entry on next read
  const removedName = persisted[0]!.src.split('/').at(-1)!;
  await unlink(join(directory, removedName));
  const afterDelete = await reloadedLibrary.listImportedFonts();
  assert.equal(afterDelete.length, 1);
  assert.equal(fontAssetMetadata(afterDelete[0])?.family, '字体乙');

  await writeFile(file, fontFixture('changed'));
  await assert.rejects(library.previewFont(face.faceId), /变化/);
  console.log('font-library.verify: grants, TTC choice, persistent multi-import, cross-restart listing, dedupe, stale-file rejection passed');
} finally { await rm(directory, { recursive: true, force: true }); }
