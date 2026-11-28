// Small structural SFNT fixtures for metadata/import tests; not glyph-render fixtures.
const align = (value: number) => Math.ceil(value / 4) * 4;
function utf16be(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
  Array.from(text).forEach((char, i) => view.setUint16(i * 2, char.charCodeAt(0)));
  return bytes;
}
export function fontFixture(
  family = '测试黑体',
  weight = 400,
  extra?: { englishFamily?: string; postscriptName?: string },
): Uint8Array {
  const names: Array<readonly [number, number, string]> = [
    [0x0804, 1, family],
    [0x0804, 2, 'Regular'],
    [0x0804, 4, `${family} Regular`],
    [0x0804, 6, extra?.postscriptName ?? `TestSans${weight}`],
  ];
  if (extra?.englishFamily) {
    names.push([0x0409, 1, extra.englishFamily]);
    names.push([0x0409, 4, `${extra.englishFamily} Regular`]);
  }
  const strings = names.map(([, , value]) => utf16be(value));
  const name = new Uint8Array(6 + names.length * 12 + strings.reduce((sum, bytes) => sum + bytes.length, 0));
  const nameView = new DataView(name.buffer), storage = 6 + names.length * 12;
  nameView.setUint16(2, names.length); nameView.setUint16(4, storage);
  let position = storage;
  names.forEach(([language, id], index) => {
    const at = 6 + index * 12;
    nameView.setUint16(at, 3); nameView.setUint16(at + 2, 1); nameView.setUint16(at + 4, language);
    nameView.setUint16(at + 6, id); nameView.setUint16(at + 8, strings[index]!.length); nameView.setUint16(at + 10, position - storage);
    name.set(strings[index]!, position); position += strings[index]!.length;
  });
  const head = new Uint8Array(54), os2 = new Uint8Array(64);
  new DataView(os2.buffer).setUint16(4, weight);
  const tables = [['head', head], ['name', name], ['cmap', new Uint8Array(4)], ['OS/2', os2]] as const;
  const bytes = new Uint8Array(12 + 16 * tables.length + tables.reduce((sum, [, table]) => sum + align(table.length), 0));
  const view = new DataView(bytes.buffer); view.setUint32(0, 0x00010000); view.setUint16(4, tables.length);
  let cursor = 12 + tables.length * 16;
  tables.forEach(([tag, data], index) => {
    const at = 12 + index * 16;
    bytes.set(Array.from(tag).map((char) => char.charCodeAt(0)), at);
    view.setUint32(at + 8, cursor); view.setUint32(at + 12, data.length);
    bytes.set(data, cursor); cursor += align(data.length);
  });
  return bytes;
}

export function fontCollectionFixture(faces: readonly Uint8Array[]): Uint8Array {
  const header = 12 + 4 * faces.length;
  const bytes = new Uint8Array(header + faces.reduce((sum, face) => sum + align(face.length), 0));
  const view = new DataView(bytes.buffer); bytes.set([116, 116, 99, 102]); view.setUint32(4, 0x00010000); view.setUint32(8, faces.length);
  let offset = header;
  faces.forEach((face, index) => {
    view.setUint32(12 + index * 4, offset); bytes.set(face, offset);
    const count = new DataView(face.buffer, face.byteOffset, face.byteLength).getUint16(4);
    for (let table = 0; table < count; table++) {
      const at = offset + 12 + table * 16 + 8;
      view.setUint32(at, view.getUint32(at) + offset);
    }
    offset += align(face.length);
  });
  return bytes;
}
