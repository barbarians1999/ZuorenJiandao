import assert from 'node:assert/strict';

// Product still requests are capped at 16. Keep batches smaller and require
// every requested frame, so extending an acceptance case cannot silently drop it.
export async function chapterComparisonStills(render, options) {
  const stills = [];
  for (let offset = 0; offset < options.frames.length; offset += 8) {
    options.signal?.throwIfAborted();
    const frames = options.frames.slice(offset, offset + 8);
    const batch = await render({ ...options, frames });
    assert.deepEqual(batch.map((still) => still.frame), frames, 'all comparison frames must be rendered, in order');
    stills.push(...batch);
  }
  return stills;
}
