// Prebuild the Remotion serve bundle into desktop-dist/remotion-bundle during packaging.
// Packaged builds do not include the src/ tree or webpack, so this is the only available render serveUrl.
// On first launch, main.ts copies it into userData and passes the path to render.mjs via CC_REMOTION_BUNDLE.
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chapterSourceDigest } from '../scripts/chapter-render-bundle.mjs';
// @ts-expect-error — plain .mjs render pipeline has no .d.ts
import { prebuildServeBundle } from '../remotion/render.mjs';

const out = join(process.cwd(), 'desktop-dist', 'remotion-bundle');
const sourceDigest = await chapterSourceDigest();
const dir = await prebuildServeBundle(out);
assert.equal(await chapterSourceDigest(), sourceDigest, 'Source changed during desktop bundle build');
await writeFile(join(dir, 'chapter-source-provenance.json'), JSON.stringify({ version: 1, sourceDigest }));
console.log(`[prebuild-remotion] serve bundle → ${dir}`);
