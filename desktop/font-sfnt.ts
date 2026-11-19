import type { FontFaceMetadata } from '../shared/desktop-fonts.ts';

// We read metadata and copy SFNT tables; Chromium remains the font renderer.
// No glyph outlines, shaping implementation, native addon, or external runtime.
const MAX_FONT_BYTES = 128 * 1024 * 1024;
const MAX_FACES = 512;
const MAX_TABLES = 256;
interface Table { tag: string; offset: number; length: number }

function range(bytes: Uint8Array, offset: number, length: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0
    || offset > bytes.length || length > bytes.length - offset) throw new Error('字体文件损坏：数据超出文件范围');
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function u16(bytes: Uint8Array, offset: number): number { range(bytes, offset, 2); return view(bytes).getUint16(offset); }
function u32(bytes: Uint8Array, offset: number): number { range(bytes, offset, 4); return view(bytes).getUint32(offset); }
function tagAt(bytes: Uint8Array, offset: number): string { range(bytes, offset, 4); return String.fromCharCode(...bytes.subarray(offset, offset + 4)); }

function faceOffsets(bytes: Uint8Array): number[] {
  if (bytes.length < 12 || bytes.length > MAX_FONT_BYTES) throw new Error('字体文件大小无效（最多 128 MB）');
  if (tagAt(bytes, 0) !== 'ttcf') return [0];
  const count = u32(bytes, 8);
  if (!count || count > MAX_FACES) throw new Error('字体集合中的字体数量无效');
  range(bytes, 12, count * 4);
  return Array.from({ length: count }, (_, i) => u32(bytes, 12 + i * 4));
}

function tablesAt(bytes: Uint8Array, offset: number): Table[] {
  const signature = u32(bytes, offset);
  if (signature !== 0x00010000 && tagAt(bytes, offset) !== 'OTTO' && tagAt(bytes, offset) !== 'true') {
    throw new Error('不支持的字体格式；请选择 TTF、OTF 或 TTC');
  }
  const count = u16(bytes, offset + 4);
  if (!count || count > MAX_TABLES) throw new Error('字体表数量无效');
  range(bytes, offset + 12, count * 16);
  const tables: Table[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const at = offset + 12 + i * 16;
    const tag = tagAt(bytes, at);
    if (seen.has(tag)) throw new Error('字体文件包含重复的数据表');
    const table = { tag, offset: u32(bytes, at + 8), length: u32(bytes, at + 12) };
    range(bytes, table.offset, table.length);
    seen.add(tag); tables.push(table);
  }
  if (!seen.has('name') || !seen.has('head') || !seen.has('cmap')) throw new Error('字体文件缺少必要的数据表');
  return tables;
}

function decodedName(bytes: Uint8Array, platform: number): string {
  let text = '';
  if (platform === 0 || platform === 3) {
    if (bytes.length % 2) return '';
    for (let i = 0; i < bytes.length; i += 2) text += String.fromCharCode(u16(bytes, i));
  } else if (platform === 1) {
    text = new TextDecoder('macintosh').decode(bytes);
  }
  return text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 512);
}

function fontNames(bytes: Uint8Array, table: Table): Map<number, string> {
  if (table.length < 6) throw new Error('字体名称表无效');
  const count = u16(bytes, table.offset + 2);
  const storage = table.offset + u16(bytes, table.offset + 4);
  if (count > 4096 || 6 + count * 12 > table.length) throw new Error('字体名称表无效');
  const names = new Map<number, { value: string; rank: number }>();
  for (let i = 0; i < count; i++) {
    const at = table.offset + 6 + i * 12;
    const platform = u16(bytes, at), language = u16(bytes, at + 4), id = u16(bytes, at + 6);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    const length = u16(bytes, at + 8), start = storage + u16(bytes, at + 10);
    if (start < table.offset || length > 16384 || start + length > table.offset + table.length) throw new Error('字体名称超出名称表范围');
    const value = decodedName(bytes.subarray(start, start + length), platform);
    if (!value) continue;
    const rank = language === 0x0804 ? 100 : language === 0x0404 ? 90 : language === 0x0409 ? 80 : platform === 0 ? 60 : platform === 3 ? 50 : 10;
    if (rank > (names.get(id)?.rank ?? -1)) names.set(id, { value, rank });
  }
  return new Map([...names].map(([id, entry]) => [id, entry.value]));
}

function metadataAt(bytes: Uint8Array, offset: number, faceIndex: number): FontFaceMetadata {
  const tables = tablesAt(bytes, offset);
  const find = (name: string) => tables.find((table) => table.tag === name);
  const names = fontNames(bytes, find('name')!);
  const family = names.get(16) ?? names.get(1);
  if (!family) throw new Error('无法读取字体名称');
  const subfamily = names.get(17) ?? names.get(2) ?? '';
  const os2 = find('OS/2'), head = find('head');
  const weight = os2 && os2.length >= 6 ? Math.max(1, Math.min(1000, u16(bytes, os2.offset + 4))) : 400;
  const italic = os2 && os2.length >= 64 ? !!(u16(bytes, os2.offset + 62) & 1)
    : !!(head && head.length >= 46 && (u16(bytes, head.offset + 44) & 2));
  let weightRange: readonly [number, number] | undefined;
  const fvar = find('fvar');
  if (fvar && fvar.length >= 16) {
    const axesStart = fvar.offset + u16(bytes, fvar.offset + 4), axesCount = u16(bytes, fvar.offset + 8), axisSize = u16(bytes, fvar.offset + 10);
    if (axesCount > 64 || axisSize < 20 || axesStart + axesCount * axisSize > fvar.offset + fvar.length) throw new Error('可变字体轴表无效');
    for (let i = 0; i < axesCount; i++) {
      const at = axesStart + i * axisSize;
      if (tagAt(bytes, at) !== 'wght') continue;
      const min = view(bytes).getInt32(at + 4) / 65536, max = view(bytes).getInt32(at + 12) / 65536;
      if (min >= 1 && max <= 1000 && min <= max) weightRange = [min, max];
    }
  }
  return { family, subfamily, fullName: names.get(4) ?? `${family} ${subfamily}`.trim(),
    postscriptName: names.get(6) ?? family, weight, style: italic ? 'italic' : 'normal', faceIndex,
    ...(weightRange ? { weightRange } : {}) };
}

export function readFontFaces(bytes: Uint8Array): FontFaceMetadata[] {
  return faceOffsets(bytes).map((offset, index) => metadataAt(bytes, offset, index));
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4; j++) word = (word << 8) | (bytes[i + j] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** Extract one collection face, rebasing shared tables and recomputing checksums. */
export function standaloneFontFace(bytes: Uint8Array, faceIndex: number): { bytes: Uint8Array; extension: '.ttf' | '.otf'; metadata: FontFaceMetadata } {
  const offsets = faceOffsets(bytes), offset = offsets[faceIndex];
  if (!Number.isInteger(faceIndex) || offset === undefined) throw new Error('请选择有效的字体集合成员');
  const metadata = metadataAt(bytes, offset, faceIndex);
  const extension = tagAt(bytes, offset) === 'OTTO' ? '.otf' : '.ttf';
  if (tagAt(bytes, 0) !== 'ttcf') return { bytes: bytes.slice(), extension, metadata };
  const tables = tablesAt(bytes, offset).filter((table) => table.tag !== 'DSIG').sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0);
  const padded = (length: number) => Math.ceil(length / 4) * 4;
  const length = 12 + tables.length * 16 + tables.reduce((total, table) => total + padded(table.length), 0);
  if (length > MAX_FONT_BYTES) throw new Error('提取后的字体超过大小上限');
  const out = new Uint8Array(length), output = view(out);
  out.set(bytes.subarray(offset, offset + 4));
  output.setUint16(4, tables.length);
  const power = 2 ** Math.floor(Math.log2(tables.length));
  output.setUint16(6, power * 16); output.setUint16(8, Math.log2(power)); output.setUint16(10, tables.length * 16 - power * 16);
  let cursor = 12 + tables.length * 16, headOffset = -1;
  tables.forEach((table, index) => {
    const at = 12 + index * 16;
    out.set(Array.from(table.tag).map((char) => char.charCodeAt(0)), at);
    out.set(bytes.subarray(table.offset, table.offset + table.length), cursor);
    if (table.tag === 'head') {
      if (table.length < 12) throw new Error('字体头表无效');
      headOffset = cursor; output.setUint32(cursor + 8, 0);
    }
    output.setUint32(at + 4, checksum(out.subarray(cursor, cursor + table.length)));
    output.setUint32(at + 8, cursor); output.setUint32(at + 12, table.length);
    cursor += padded(table.length);
  });
  if (headOffset < 0) throw new Error('字体缺少头表');
  output.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return { bytes: out, extension, metadata };
}
