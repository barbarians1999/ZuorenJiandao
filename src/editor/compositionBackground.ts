const TRANSPARENCY_GRID = 'repeating-conic-gradient(#242424 0% 25%, #1c1c1c 0% 50%) 50% / 40px 40px';

/** The checkerboard is a preview aid, never part of an exported picture.
 * Nested sequences and explicit alpha exports keep their transparent surface. */
export function compositionBackground(transparent: boolean, exporting: boolean): string | undefined {
  return transparent ? undefined : exporting ? '#000000' : TRANSPARENCY_GRID;
}
