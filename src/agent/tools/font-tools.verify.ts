// Runnable: `npx tsx src/agent/font-tools.check.ts`
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import type { AgentContext } from '../context';
import {
  execFontTool,
  FONT_TOOL_NAMES,
  FONT_TOOL_SCHEMAS,
  fontFallbackGate,
  collectReferencedFonts,
  findUnsupportedFonts,
} from './font-tools';
import { searchFontCatalog, isLoadableFontFamily } from '../../fonts/googleFonts';
import { LOCAL_FONTS, ensureLocalFont, findLocalFont } from '../../fonts/localFonts';
import { timelineToFcpxml } from '../../export/fcpxml';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { validateTextClipProps } from '../../editor/textStyles';
import { execOfflineEditItemTool } from '../../../server/external-agent/offline-edit-item';
import { execCoreTool } from './core-tools';
import { execCaptionsTool } from './captions-tools';
import { searchLocalFontEntries } from '../../fonts/fontLookup';
import type { DesktopFontFace } from '../../../shared/desktop-fonts';

assert.ok(FONT_TOOL_NAMES.has('search_fonts'));
assert.strictEqual(FONT_TOOL_SCHEMAS[0]!.name, 'search_fonts');

const draft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [],
}));
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
};

// search_fonts — bundled Inter
const inter = await execFontTool('search_fonts', { query: 'inter' }, ctx) as {
  ok: boolean; results: Array<{ family: string; loadable: boolean; source: string }>;
};
assert.strictEqual(inter.ok, true);
assert.deepEqual(inter.results.filter((r) => r.family === 'Inter').map((r) => [r.loadable, r.source]), [[true, 'bundled']]);

// Chinese alias → bundled local font (loadable, source:'bundled')
const deyi = searchFontCatalog('得意黑');
assert.ok(deyi.some((r) => r.family === 'Smiley Sans' && r.loadable && r.source === 'bundled'));

// every bundled family + its Chinese aliases hit the search catalog
for (const font of LOCAL_FONTS) {
  for (const query of [font.family, ...font.aliasZh]) {
    assert.ok(
      searchFontCatalog(query).some((r) => r.family === font.family && r.source === 'bundled'),
      `search miss: ${query} → ${font.family}`,
    );
  }
}

// search_fonts tool surfaces bundled fonts with source marker
const douyin = await execFontTool('search_fonts', { query: '抖音美好体' }, ctx) as {
  ok: boolean; results: Array<{ family: string; loadable: boolean; source: string }>;
};
assert.ok(douyin.results.some((r) => r.family === 'Douyin Meihao Ti' && r.loadable && r.source === 'bundled'));

// every mapped URL points at a real woff2 under assets/
const assetsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'assets');
for (const font of LOCAL_FONTS) {
  for (const url of Object.values(font.files ?? {})) {
    assert.ok(url.startsWith('/fonts/'), `bad url shape: ${url}`);
    assert.ok(existsSync(join(assetsDir, url)), `missing woff2: assets${url}`);
  }
}

// alias resolution + ensureLocalFont promise cache (node path: no FontFace, still cached)
assert.strictEqual(findLocalFont('轻松手写体一')?.family, 'Qingsong Shouxie Ti Yi');
assert.strictEqual(findLocalFont('新青年'), undefined);
assert.strictEqual(findLocalFont('思源黑体')?.family, 'Noto Sans SC');
assert.strictEqual(findLocalFont('鸿蒙'), undefined);
assert.strictEqual(findLocalFont('Comic Sans MS'), undefined);
assert.strictEqual(ensureLocalFont('得意黑'), ensureLocalFont('Smiley Sans'));
await ensureLocalFont('得意黑');
await ensureLocalFont('not-a-local-font'); // non-local resolves, never throws

// loadable check — bundled CJK now export-safe
assert.strictEqual(isLoadableFontFamily('Inter'), true);
assert.strictEqual(isLoadableFontFamily('Smiley Sans'), true);
assert.strictEqual(isLoadableFontFamily('抖音美好体'), true);
assert.strictEqual(isLoadableFontFamily('Comic Sans MS'), false);
assert.strictEqual(isLoadableFontFamily('system-ui, sans-serif'), true);

// Gate: clean timeline passes
const cleanState = draft.getState();
assert.strictEqual(fontFallbackGate(cleanState, false), null);

// Gate: MG with unsupported font blocks without confirm
const blockedState: TimelineState = {
  ...cleanState,
  items: [{
    id: 'mg1',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
    name: 'Title',
    kind: 'motion-graphic',
    props: { fontFamily: 'Comic Sans MS', title: '你好' },
  }],
};
const refs = collectReferencedFonts(blockedState);
assert.ok(refs.includes('Comic Sans MS'));
const bad = findUnsupportedFonts(blockedState);
assert.deepStrictEqual(bad.unsupported, ['Comic Sans MS']);

const gate = fontFallbackGate(blockedState, false);
assert.ok(gate);
assert.strictEqual(gate!.error, 'unsupported_fonts');
assert.ok((gate!.unsupportedFonts as string[]).includes('Comic Sans MS'));

// confirm bypasses
assert.strictEqual(fontFallbackGate(blockedState, true), null);

// loadable MG font does not gate
const okState: TimelineState = {
  ...cleanState,
  items: [{
    id: 'mg2',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 90,
    name: 'Title',
    kind: 'motion-graphic',
    props: { fontFamily: 'Playfair Display' },
    code: `const s = { fontFamily: 'Inter' };`,
  }],
};
assert.strictEqual(fontFallbackGate(okState, false), null);
assert.ok(collectReferencedFonts(okState).includes('Playfair Display'));
assert.ok(collectReferencedFonts(okState).includes('Inter'));

// nleFormat resolve vs premiere
const xmlPrem = timelineToFcpxml(cleanState, { nleFormat: 'fcp_xml' });
const xmlRes = timelineToFcpxml(cleanState, { nleFormat: 'fcp_xml_resolve' });
assert.ok(xmlPrem.includes('ChatCut Export'));
assert.ok(!xmlPrem.includes('colorSpace='));
assert.ok(xmlRes.includes('ChatCut Export (Resolve)'));
assert.ok(xmlRes.includes('colorSpace="1-1-1 (Rec. 709)"'));

// Unrestricted fontFamily: arbitrary OS/custom font names are no longer blocked by a fixed whitelist
assert.strictEqual(validateTextClipProps({ text: '任意字体', fontFamily: '方正小标宋简体' }), null);
assert.strictEqual(validateTextClipProps({ text: '任意字体', fontFamily: 'AnyCustomOSFont' }), null);
assert.strictEqual(validateTextClipProps({ text: '空字体', fontFamily: '   ' }), 'text fontFamily cannot be empty');

// System & imported font search + auto-binding across search_fonts, edit_item, update_item_props, edit_captions
{
  const systemFace: DesktopFontFace = {
    faceId: 'sys-fz-1',
    family: '方正小标宋简体',
    fullName: '方正小标宋简体 Regular',
    postscriptName: 'FZXBSJW--GB1-0',
    subfamily: 'Regular',
    weight: 400,
    style: 'normal',
    faceIndex: 0,
    source: 'system',
    filename: 'FZXiaoBiaoSong-B05S.ttf',
    aliases: ['FZXiaoBiaoSong-B05S'],
  };
  const systemAsset: MediaAsset = {
    id: 'font_fz_sys',
    kind: 'file',
    name: '方正小标宋简体 Regular',
    sourceFilename: 'FZXiaoBiaoSong-B05S.ttf',
    src: '/media/uploads/font-fz-sys.ttf',
    durationInFrames: 0,
    sourceContentHash: 'fz-hash',
    props: {
      resourceType: 'font',
      font: {
        family: '方正小标宋简体',
        fullName: '方正小标宋简体 Regular',
        postscriptName: 'FZXBSJW--GB1-0',
        subfamily: 'Regular',
        weight: 400,
        style: 'normal',
        faceIndex: 0,
        source: 'system',
        format: 'truetype',
        aliases: ['FZXiaoBiaoSong-B05S'],
      },
    },
  };

  const localDraft = makeDraft(docFromTimeline({
    fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [],
  }));
  const localCtx: AgentContext = {
    commands: localDraft.commands,
    getState: localDraft.getState,
    getDoc: localDraft.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    fontResolver: {
      async searchLocalFonts(query, projectAssets, limit = 25) {
        return searchLocalFontEntries(query, projectAssets, [], [systemFace], limit);
      },
      async resolveFont(rawFamily, projectAssets) {
        const clean = rawFamily.trim().toLowerCase();
        if (clean === '方正小标宋简体' || clean === 'fzxiaoBiaosong-b05s'.toLowerCase() || clean === 'fzxiaobiaosong-b05s' || clean === 'fzxbsjw--gb1-0') {
          const already = projectAssets.find((a) => a.id === systemAsset.id);
          return already
            ? { fontFamily: '方正小标宋简体', fontAssetId: systemAsset.id, source: 'project' }
            : { fontFamily: '方正小标宋简体', fontAssetId: systemAsset.id, asset: systemAsset, source: 'system' };
        }
        return null;
      },
    },
  };

  const searchZh = await execFontTool('search_fonts', { query: '方正小标宋' }, localCtx) as {
    results: Array<{ family: string; source: string; loadable: boolean }>;
  };
  assert.ok(searchZh.results.some((r) => r.family === '方正小标宋简体' && r.source === 'system' && r.loadable));

  const searchEn = await execFontTool('search_fonts', { query: 'FZXiaoBiaoSong-B05S' }, localCtx) as {
    results: Array<{ family: string; source: string; aliases: string[] }>;
  };
  assert.ok(searchEn.results.some((r) => r.family === '方正小标宋简体' && r.aliases.includes('FZXiaoBiaoSong-B05S')));

  // validateOnly must not leak resolved assets into doc.assets
  const dryRun = await execOfflineEditItemTool('edit_item', {
    validateOnly: true,
    adds: [{ type: 'text', text: '试运行', fontFamily: 'FZXiaoBiaoSong-B05S', track: 'V1', fromFrame: 0, durationInFrames: 60 }],
  }, localCtx) as { ok?: boolean };
  assert.strictEqual(dryRun.ok, true);
  assert.strictEqual(localDraft.getDoc().assets.length, 0);

  // Real add with English/PostScript name auto-attaches system asset & fontAssetId
  const added = await execOfflineEditItemTool('edit_item', {
    adds: [
      { type: 'text', text: '标题一', fontFamily: 'FZXiaoBiaoSong-B05S', track: 'V1', fromFrame: 0, durationInFrames: 60 },
      { type: 'text', text: '任意自定义', fontFamily: 'MyArbitraryOSFont', track: 'V1', fromFrame: 60, durationInFrames: 60 },
    ],
  }, localCtx) as { ok?: boolean };
  assert.strictEqual(added.ok, true);
  assert.strictEqual(localDraft.getDoc().assets.length, 1);
  assert.strictEqual(localDraft.getDoc().assets[0]?.id, systemAsset.id);
  const textItems = localDraft.getState().items;
  assert.strictEqual(textItems[0]?.props?.fontAssetId, systemAsset.id);
  assert.strictEqual(textItems[0]?.props?.fontFamily, '方正小标宋简体');
  assert.strictEqual(textItems[1]?.props?.fontFamily, 'MyArbitraryOSFont');

  // update_item_props also resolves system font names
  const propUpdate = await execCoreTool('update_item_props', {
    itemId: textItems[1]!.id,
    props: { fontFamily: '方正小标宋简体' },
  }, localCtx, []) as { ok?: boolean };
  assert.strictEqual(propUpdate.ok, true);
  assert.strictEqual(localDraft.getState().items[1]?.props?.fontAssetId, systemAsset.id);

  // edit_captions style also resolves system font names
  await execCaptionsTool('edit_captions', { action: 'enable', json: { manual: true } }, localCtx);
  const capStyle = await execCaptionsTool('edit_captions', {
    action: 'style',
    json: { fontFamily: 'FZXiaoBiaoSong-B05S' },
  }, localCtx) as { ok?: boolean };
  assert.strictEqual(capStyle.ok, true);
  assert.strictEqual(localDraft.getState().captions?.styleOverride?.fontAssetId, systemAsset.id);

  // When a clip binds fontAssetId, fontFallbackGate passes export readiness check
  assert.strictEqual(fontFallbackGate({
    ...localDraft.getState(),
    items: [localDraft.getState().items[0]!],
    captions: null,
  }, false), null);
}

console.log('font-tools.check: ok');
