import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopFontLibrary } from './font-library.ts';
import { fontCollectionFixture, fontFixture } from './font-test-fixture.ts';
import { fontAssetMetadata } from '../shared/desktop-fonts.ts';

const directory = await mkdtemp(join(tmpdir(), 'zuoren-font-check-'));
try {
  const file = join(directory, 'font.ttc'), broken = join(directory, 'broken.ttf');
  await writeFile(file, fontCollectionFixture([fontFixture('第一种'), fontFixture('第二种', 700)]));
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
  await writeFile(file, fontFixture('changed'));
  await assert.rejects(library.previewFont(face.faceId), /变化/);
  console.log('font-library.verify: grants, TTC choice, copy/hash dedupe, stale-file rejection passed');
} finally { await rm(directory, { recursive: true, force: true }); }
