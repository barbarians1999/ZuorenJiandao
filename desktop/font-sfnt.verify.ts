import assert from 'node:assert/strict';
import { readFontFaces, standaloneFontFace } from './font-sfnt.ts';
import { fontCollectionFixture, fontFixture } from './font-test-fixture.ts';

const regular = fontFixture('测试黑体', 400), bold = fontFixture('测试粗体', 700);
assert.equal(readFontFaces(regular)[0]?.family, '测试黑体');
assert.equal(readFontFaces(bold)[0]?.weight, 700);
const collection = fontCollectionFixture([regular, bold]);
assert.deepEqual(readFontFaces(collection).map((face) => [face.family, face.faceIndex]), [['测试黑体', 0], ['测试粗体', 1]]);
const extracted = standaloneFontFace(collection, 1);
assert.equal(extracted.metadata.family, '测试粗体');
assert.equal(readFontFaces(extracted.bytes)[0]?.family, '测试粗体');
assert.equal(readFontFaces(extracted.bytes).length, 1);
let sum = 0;
for (let at = 0; at < extracted.bytes.length; at += 4) sum = (sum + new DataView(extracted.bytes.buffer).getUint32(at)) >>> 0;
assert.equal(sum, 0xb1b0afba, 'TTC extraction must produce a valid whole-file checksum');
assert.throws(() => standaloneFontFace(collection, 2), /有效/);
assert.throws(() => readFontFaces(new Uint8Array(4)), /大小/);
const bad = regular.slice(); new DataView(bad.buffer).setUint32(20, 0xffffffff);
assert.throws(() => readFontFaces(bad), /范围/);
const duplicate = regular.slice(); duplicate.set(duplicate.subarray(12, 16), 28);
assert.throws(() => readFontFaces(duplicate), /重复/);
const bilingual = fontFixture('方正小标宋简体', 400, {
  englishFamily: 'FZXiaoBiaoSong-B05S',
  postscriptName: 'FZXBSJW--GB1-0',
});
const bilingualFace = readFontFaces(bilingual)[0]!;
assert.equal(bilingualFace.family, '方正小标宋简体');
assert.equal(bilingualFace.postscriptName, 'FZXBSJW--GB1-0');
assert.ok(bilingualFace.aliases?.includes('FZXiaoBiaoSong-B05S'), 'retains English alias alongside Chinese family');
console.log('font-sfnt.verify: metadata, multilingual aliases, TTC extraction/checksums, malformed bounds passed');
