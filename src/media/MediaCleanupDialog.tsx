// "Clean Assets" panel: scan after opening and list uploaded files that are not referenced by any project,
// allowing batch confirmation and deletion (disk + IDB cache).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { theme, themeAlpha } from '../theme';
import { useT } from '../i18n/locale';
import { Icon } from '../components/icons';
import { scanUnreferenced, collectAllUploadRefs, deleteUploadFile, type UploadFileInfo } from '../persist/mediaCleanup';

interface MediaCleanupDialogProps {
  onClose: () => void;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MediaCleanupDialog({ onClose }: MediaCleanupDialogProps) {
  const t = useT();
  const [files, setFiles] = useState<UploadFileInfo[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const rescan = useCallback(async () => {
    setFiles(null);
    try {
      const scan = await scanUnreferenced();
      setFiles(scan.files);
      setPicked(new Set());
    } catch (err) {
      setFiles([]);
      setNote(t('扫描失败:{msg}', { msg: err instanceof Error ? err.message : String(err) }));
    }
  }, [t]);
  useEffect(() => { void rescan(); }, [rescan]);

  const pickedBytes = useMemo(
    () => (files ?? []).filter((f) => picked.has(f.name)).reduce((s, f) => s + f.bytes, 0),
    [files, picked],
  );

  const toggle = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const removePicked = async () => {
    if (busy || !files || picked.size === 0) return;
    setBusy(true);
    let currentRefs: Set<string>;
    try { currentRefs = await collectAllUploadRefs(); }
    catch {
      setNote(t('无法完整检查工程引用，未删除素材。请稍后重新扫描。'));
      setBusy(false);
      return;
    }
    let ok = 0;
    let fail = 0;
    for (const f of files) {
      if (!picked.has(f.name)) continue;
      if (currentRefs.has(`/media/uploads/${f.name}`)) { fail += 1; continue; }
      if (await deleteUploadFile(f.name).catch(() => false)) ok += 1;
      else fail += 1;
    }
    setBusy(false);
    setNote(fail ? t('已删 {ok} 个,{fail} 个失败', { ok, fail }) : t('已删 {n} 个文件', { n: ok }));
    await rescan();
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: `0.5px solid ${theme.border}` }}>
          <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="trash" size={15} /></span>
          <b style={{ fontSize: 13.5 }}>{t('清理素材')}</b>
          <span style={{ color: theme.textDim, fontSize: 12 }}>{t('列出所有工程都不引用的上传文件')}</span>
          <button onClick={onClose} style={{ ...miniBtn, marginLeft: 'auto' }} title={t('关闭')}>✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 8px' }}>
          {files === null && <div style={hint}>{t('扫描中…(逐工程收集引用)')}</div>}
          {files !== null && files.length === 0 && <div style={hint}>{t('没有无主素材,盘上很干净 ✨')}</div>}
          {files?.map((f) => (
            <label key={f.name} style={row}>
              <input type="checkbox" checked={picked.has(f.name)} onChange={() => toggle(f.name)} style={{ accentColor: theme.accent }} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>{f.name}</span>
              <span style={cell}>{fmtBytes(f.bytes)}</span>
              <span style={{ ...cell, width: 76 }}>{fmtDate(f.mtimeMs)}</span>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderTop: `0.5px solid ${theme.border}` }}>
          {note && <span style={{ color: theme.textDim, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>}
          <span style={{ marginLeft: 'auto', color: theme.textDim, fontSize: 12, flexShrink: 0 }}>
            {t('已选 {n} 个 · {size}', { n: picked.size, size: fmtBytes(pickedBytes) })}
          </span>
          <button onClick={() => void removePicked()} disabled={busy || picked.size === 0} style={dangerBtn}>
            {busy ? t('删除中…') : t('删除所选')}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 120, background: themeAlpha.shadow(0.55),
  display: 'grid', placeItems: 'center',
};
const panel: React.CSSProperties = {
  width: 560, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 96px)',
  display: 'flex', flexDirection: 'column', overflow: 'hidden',
  background: theme.panel, border: '1px solid transparent', borderRadius: 18,
  boxShadow: `0 20px 56px ${themeAlpha.shadow(0.65)}`, color: theme.text,
};
const hint: React.CSSProperties = { padding: '28px 12px', textAlign: 'center', color: theme.textDim, fontSize: 13 };
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
};
const cell: React.CSSProperties = { color: theme.textDim, fontSize: 11.5, fontVariantNumeric: 'tabular-nums', flexShrink: 0, width: 64, textAlign: 'right' };
const miniBtn: React.CSSProperties = { background: theme.panelAlt, border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13, width: 28, height: 28, borderRadius: 999, display: 'grid', placeItems: 'center' };
const dangerBtn: React.CSSProperties = {
  background: theme.accent, border: 'none', color: theme.onAccent, cursor: 'pointer',
  fontSize: 13, fontWeight: 650, padding: '7px 16px', borderRadius: 999, flexShrink: 0,
};
