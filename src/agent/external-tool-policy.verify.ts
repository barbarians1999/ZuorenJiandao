import assert from 'node:assert/strict';
import { isExternalServerDirectCall } from './external-tool-policy.ts';

assert.equal(isExternalServerDirectCall('edit_captions', { action: 'display_text' }), true);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'original' }), true);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'translation' }), true);
assert.equal(
  isExternalServerDirectCall('edit_captions', { action: 'language_mode', mode: 'bilingual' }),
  false,
  'language_mode bilingual can reach translation/provider work and must stay browser-confirmed',
);
assert.equal(
  isExternalServerDirectCall('edit_captions', { action: 'bilingual', languageCode: 'en' }),
  false,
  'bilingual can reach translation/provider work and must stay browser-confirmed',
);
assert.equal(isExternalServerDirectCall('edit_captions', { action: 'preset_apply' }), false);
assert.equal(isExternalServerDirectCall('submit_video', {}), false);

for (const tool of [
  'browse_local_media',
  'import_asset',
  'import_assets',
  'import_folder',
  'import_media',
  'finalize_uploaded_asset',
  'request_asset_download',
  'manage_media_pool',
]) {
  assert.equal(isExternalServerDirectCall(tool, {}), true, `${tool} is server-direct`);
}

assert.equal(
  isExternalServerDirectCall('edit_item', {
    adds: [{ type: 'video', assetId: 'asset-1', track: 'V1', fromFrame: 0 }],
    updates: [{ type: 'audio', itemId: 'clip-1', volume: 0.8 }],
  }),
  true,
  'pool media adds and generic clip updates stay server-direct',
);
assert.equal(
  isExternalServerDirectCall('edit_item', { adds: [{ type: 'effect', targetItemId: 'clip-1', assetId: 'fx:blur' }] }),
  false,
  'GL effect additions remain browser-only',
);
assert.equal(
  isExternalServerDirectCall('edit_item', { adds: [{ type: 'transition', incomingItemId: 'clip-2', assetId: 'tr:wipe' }] }),
  false,
  'GL transition additions remain browser-only',
);
assert.equal(
  isExternalServerDirectCall('edit_item', { adds: [{ type: 'motion-graphic', assetId: 'library:motion-graphic:title' }] }),
  false,
  'library motion-graphic additions remain browser-only',
);
assert.equal(
  isExternalServerDirectCall('edit_item', { adds: [{ type: 'audio', assetId: 'library:sound:pop' }] }),
  false,
  'library SFX additions remain browser-only',
);
