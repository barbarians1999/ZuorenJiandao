import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopFontFace, FontChoice } from '../../shared/desktop-fonts';
import { fontAssetMetadata } from '../../shared/desktop-fonts';
import type { MediaAsset } from '../editor/mediaTypes';
import { useT } from '../i18n/locale';
import { useFontLibrary } from './FontLibraryProvider';
import { ensureAssetFont } from './assetFonts';
import { ensureFont } from './googleFonts';
import { getCachedFontSample, loadFontSample } from './fontSample';
import { desktopFontKey, filterFontEntries, fontPickerEntries, mergeFontAssets, nextFontRecent, readFontPreference, writeFontPreference,
  type FontPickerEntry, type FontPickerTab } from './fontPickerModel';
import './font-picker.css';

let cachedImportedFonts: MediaAsset[] = [];
const importedListeners = new Set<(assets: MediaAsset[]) => void>();
function publishImportedFonts(assets: MediaAsset[]): void {
  cachedImportedFonts = assets;
  for (const listener of importedListeners) listener(assets);
}

const TABS: readonly { id: FontPickerTab; label: string }[] = [
  { id: 'bundled', label: '内置' }, { id: 'system', label: '系统' }, { id: 'imported', label: '已导入' },
  { id: 'favorite', label: '收藏' }, { id: 'recent', label: '最近' }, { id: 'more', label: '更多字体' },
];

const FIXED_FONT_SAMPLE = '字体预览 · 影视字幕 Aa 123';

const FontSample = memo(function FontSample({ entry, text }: { entry: FontPickerEntry; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<{ family?: string; error?: string }>(() => getCachedFontSample(entry) ?? {});
  useEffect(() => {
    const cached = getCachedFontSample(entry);
    if (cached) {
      setState((prev) => (prev.family === cached.family && !prev.error ? prev : { family: cached.family }));
      return undefined;
    }
    let active = true;
    const load = () => {
      void loadFontSample(entry).then((sample) => { if (active) setState({ family: sample.family }); },
        (error: unknown) => { if (active) setState({ error: error instanceof Error ? error.message : '字体预览失败' }); });
    };
    const element = ref.current;
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((changes) => {
      if (changes.some((change) => change.isIntersecting)) { observer?.disconnect(); load(); }
    });
    if (observer && element) observer.observe(element); else load();
    return () => { active = false; observer?.disconnect(); };
  }, [entry.key, entry.face?.faceId, entry.asset?.src, entry.asset?.sourceContentHash]);
  return <span ref={ref} className={`cc-font-sample${state.error ? ' failed' : ''}`}
    style={state.family ? { fontFamily: state.family } : undefined} title={state.error}
    aria-label={state.error ? '字体预览失败' : undefined}>
    {state.error ? '预览失败' : state.family ? text : '加载字样…'}
  </span>;
});

export function FontPicker({ value, fontAssetId, sampleText: _sampleText, mixed = false, targetKey = '', onChange }: {
  value: string;
  fontAssetId?: string | null;
  sampleText?: string;
  mixed?: boolean;
  targetKey?: string;
  onChange: (choice: FontChoice) => void;
}) {
  const t = useT(), library = useFontLibrary(), id = useId();
  const [open, setOpen] = useState(false), [tab, setTab] = useState<FontPickerTab>('bundled'), [query, setQuery] = useState('');
  const [faces, setFaces] = useState<DesktopFontFace[]>([]), [systemLoaded, setSystemLoaded] = useState(false);
  const [importedAssets, setImportedAssets] = useState<MediaAsset[]>(() => cachedImportedFonts);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [failedEntry, setFailedEntry] = useState<FontPickerEntry | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [favorites, setFavorites] = useState(() => readFontPreference('favorite'));
  const [recent, setRecent] = useState(() => readFontPreference('recent'));
  const [position, setPosition] = useState({ left: 0, top: 0, width: 420, maxHeight: 520 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const running = useRef(false);
  const desktop = typeof window === 'undefined' ? undefined : window.openChatCutDesktop?.fonts;
  const mergedAssets = useMemo(() => mergeFontAssets(importedAssets, library.assets), [importedAssets, library.assets]);
  const entries = useMemo(() => fontPickerEntries(mergedAssets, faces), [mergedAssets, faces]);
  const visible = useMemo(() => filterFontEntries(entries, tab, query, favorites, recent), [entries, tab, query, favorites, recent]);
  const current = fontAssetId ? entries.find((entry) => entry.asset?.id === fontAssetId) : entries.find((entry) => entry.family === value && !entry.asset && !entry.face);
  const label = current?.label ?? value;
  useEffect(() => {
    importedListeners.add(setImportedAssets);
    return () => { importedListeners.delete(setImportedAssets); };
  }, []);
  useEffect(() => {
    if (!desktop?.listImportedFonts) return;
    let active = true;
    void desktop.listImportedFonts().then((assets) => {
      if (active) publishImportedFonts(assets);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [desktop, open]);
  const loadSystem = async (refresh = false) => {
    if (!desktop || loading || (systemLoaded && !refresh)) return;
    setLoading(true); setError(null); setFailedEntry(null);
    try {
      const result = await desktop.listSystemFonts(refresh);
      setFaces((existing) => [...existing.filter((face) => face.source !== 'system'), ...result.faces]);
      setUnreadable(result.unreadableFiles); setSystemLoaded(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('本机字体读取失败')); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    if (open && ['system', 'favorite', 'recent'].includes(tab) && !systemLoaded) void loadSystem();
  }, [open, tab, systemLoaded]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(440, window.innerWidth - 24), height = Math.min(540, window.innerHeight - 24);
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - 12 ? below : Math.max(12, window.innerHeight - height - 12);
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top,
        width, maxHeight: window.innerHeight - top - 12 });
    };
    place();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!busy && !trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    window.addEventListener('resize', place); window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape, true); };
  }, [open, busy]);
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (open) { setFavorites(readFontPreference('favorite')); setRecent(readFontPreference('recent')); } }, [open]);
  useEffect(() => { request.current++; running.current = false; setBusy(false); setOpen(false); setFailedEntry(null); setError(null); }, [targetKey]);

  const choose = async (entry: FontPickerEntry) => {
    if (running.current) return;
    running.current = true;
    const serial = ++request.current;
    setBusy(true); setError(null); setFailedEntry(null);
    try {
      let choice: FontChoice;
      if (entry.face) {
        if (!desktop || !library.canPersist) throw new Error(t('请在桌面工程编辑器中导入字体'));
        const asset = await desktop.materializeFont(entry.face.faceId);
        await ensureAssetFont(asset);
        if (entry.face.source === 'imported' && desktop.listImportedFonts) {
          void desktop.listImportedFonts().then(publishImportedFonts).catch(() => undefined);
        }
        choice = { fontFamily: fontAssetMetadata(asset)!.family, fontAssetId: asset.id, asset };
      } else if (entry.asset) {
        const inProject = library.assets.some((asset) => asset.id === entry.asset!.id);
        if (!inProject && !library.canPersist) throw new Error(t('请在桌面工程编辑器中导入字体'));
        await ensureAssetFont(entry.asset);
        choice = inProject
          ? { fontFamily: entry.family, fontAssetId: entry.asset.id }
          : { fontFamily: entry.family, fontAssetId: entry.asset.id, asset: entry.asset };
      } else {
        await ensureFont(entry.family);
        choice = { fontFamily: entry.family };
      }
      if (serial !== request.current) return;
      library.commit(choice, () => onChange(choice));
      const next = nextFontRecent(recent, entry.key); setRecent(next); writeFontPreference('recent', next);
      if (choice.asset) {
        const assetKey = `asset:${choice.asset.id}`;
        const importedRecent = nextFontRecent(next, assetKey); setRecent(importedRecent); writeFontPreference('recent', importedRecent);
        if (favorites.includes(entry.key) && !favorites.includes(assetKey)) {
          const nextFavorites = [...favorites, assetKey]; setFavorites(nextFavorites); writeFontPreference('favorite', nextFavorites);
        }
      }
      setOpen(false); trigger.current?.focus();
    } catch (reason) { if (serial === request.current) { setFailedEntry(entry); setError(reason instanceof Error ? reason.message : t('字体加载失败，请重试')); } }
    finally { if (serial === request.current) { running.current = false; setBusy(false); } }
  };
  const importFile = async () => {
    if (!desktop || busy) return;
    setBusy(true); setError(null); setFailedEntry(null); setImportNotice(null);
    try {
      if (typeof desktop.importFontFiles === 'function') {
        const result = await desktop.importFontFiles();
        if (!result) return;
        publishImportedFonts(result.assets);
        if (result.failed > 0) {
          setImportNotice(t('{n} 个字体文件无法读取，其余已导入。', { n: result.failed }));
        }
        setTab('imported'); setQuery('');
        return;
      }
      const picked = await desktop.chooseFontFile();
      if (!picked) return;
      setFaces((existing) => [...new Map([...existing, ...picked].map((face) => [desktopFontKey(face), face])).values()]);
      setTab('imported'); setQuery('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('字体文件无法读取')); }
    finally { setBusy(false); }
  };
  const toggleFavorite = (key: string) => {
    const next = favorites.includes(key) ? favorites.filter((entry) => entry !== key) : [...favorites, key];
    setFavorites(next); writeFontPreference('favorite', next);
  };

  return <div className="cc-font-picker">
    <button ref={trigger} type="button" className="cc-font-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
      onClick={() => { if (!busy) { setOpen((value) => !value); setError(null); } }} title={label}>
      <span>{mixed ? t('多种字体') : label}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && createPortal(<div ref={panel} id={id} className="cc-font-dialog" role="dialog" aria-label={t('选择字体')}
      data-cc-shortcut-surface="inspector" style={position} onPointerDown={(event) => event.stopPropagation()}>
      <header><strong>{t('字体')}</strong><button type="button" aria-label={t('关闭字体选择')} disabled={busy} onClick={() => setOpen(false)}>×</button></header>
      <div className="cc-font-search"><input autoFocus aria-label={t('搜索字体')} placeholder={t('搜索名称，如「思源」「黑体」')} value={query} onChange={(event) => setQuery(event.target.value)} />
        {desktop && <button type="button" disabled={busy || !library.canPersist} onClick={() => void importFile()}>{t('导入字体')}</button>}</div>
      <nav aria-label={t('字体分类')}>{TABS.map((item) => <button type="button" key={item.id} disabled={busy}
        aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setQuery(''); }}>{t(item.label)}</button>)}</nav>
      {tab === 'system' && desktop && systemLoaded && <div className="cc-font-refresh"><button type="button" disabled={busy || loading} onClick={() => void loadSystem(true)}>{t('刷新本机字体')}</button></div>}
      {busy && <p className="cc-font-status" role="status">{t('正在加载字体，完成后应用…')}</p>}
      {loading && <p className="cc-font-status" role="status">{t('正在读取本机字体…')}</p>}
      {error && <div className="cc-font-error" role="alert">{error}<button type="button" disabled={busy || loading} onClick={() => {
        if (failedEntry) void choose(failedEntry);
        else if (tab === 'system') void loadSystem(true);
        else void importFile();
      }}>{t('重试')}</button></div>}
      {unreadable > 0 && tab === 'system' && <p className="cc-font-status">{t('{n} 个字体文件无法读取，其他字体仍可使用。', { n: unreadable })}</p>}
      {importNotice && tab === 'imported' && <p className="cc-font-status" role="status">{importNotice}</p>}
      {tab === 'system' && !desktop && <p className="cc-font-status">{t('本机字体和本地导入可在 Windows 桌面版中使用。')}</p>}
      <div className="cc-font-list" role="listbox" aria-label={t('可选字体')} aria-busy={busy || loading}>
        {visible.map((entry) => {
          const selected = !mixed && (entry.asset ? entry.asset.id === fontAssetId : !fontAssetId && entry.family === value);
          return <div className={`cc-font-row${selected ? ' selected' : ''}`} key={entry.key}>
            <button type="button" role="option" aria-selected={selected} disabled={busy} className="cc-font-apply" onClick={() => void choose(entry)}>
              <span className="cc-font-name">{entry.label}{entry.source === 'google' && <small>{t('联网字体')}</small>}{entry.face && <small>{entry.face.weight}{entry.face.style === 'italic' ? ' · 斜体' : ''}</small>}</span>
              <FontSample entry={entry} text={FIXED_FONT_SAMPLE} />
            </button>
            <button type="button" className="cc-font-star" aria-label={t(favorites.includes(entry.key) ? '取消收藏字体' : '收藏字体')}
              aria-pressed={favorites.includes(entry.key)} disabled={busy} onClick={() => toggleFavorite(entry.key)}>{favorites.includes(entry.key) ? '★' : '☆'}</button>
          </div>;
        })}
        {!loading && !visible.length && <p className="cc-font-empty">{t(query ? '没有找到这个字体' : tab === 'imported' ? '点击「导入字体」，支持一次多选 TTF、OTF 和 TTC，导入后所有工程通用。' : tab === 'favorite' ? '点击字体右侧的星号收藏' : tab === 'recent' ? '使用过的字体会显示在这里' : '暂无可用字体')}</p>}
      </div>
      <footer>{t('点击字样应用；更换字体不会改变文字内容和其他样式。')}</footer>
    </div>, document.body)}
  </div>;
}
