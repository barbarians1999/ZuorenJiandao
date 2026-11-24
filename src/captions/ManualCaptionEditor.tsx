import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { TimelineItem } from '../editor/types';
import { useT } from '../i18n/locale';
import type { TranscriptWord } from '../transcript/types';
import {
  appendManualCue, appendManualLane, isManualCaptionEntry,
  removeManualCue, removeManualLane, updateManualCue,
  identifyManualCues,
} from './manualCaptions';
import type { CaptionsData, CaptionSourceEntry } from './types';
import { parseSrt } from './srt';
import { buildCues } from './captionCues';
import { planCaptionCueEdit } from './captionCueEditing';
import { captionCueKeyboardIntent } from './captionCueEditingKeyboard';

interface Props {
  captions: CaptionsData;
  items: TimelineItem[];
  fps: number;
  onUpdate: (patch: Partial<CaptionsData>) => void;
  getPlayheadMs?: () => number;
  onSeekMs?: (ms: number) => void;
  showCueList?: boolean;
  showSrtImport?: boolean;
  focusManualLane?: string | null;
  onManualFocused?: () => void;
}

export function ManualCaptionEditor({ captions, items, fps, onUpdate, getPlayheadMs, onSeekMs, focusManualLane, onManualFocused, showCueList = true, showSrtImport = true }: Props) {
  const t = useT();
  const lanes = useMemo(() => captions.sourceEntries?.filter(isManualCaptionEntry) ?? [], [captions.sourceEntries]);
  const [open, setOpen] = useState(lanes.length > 0);
  const [laneId, setLaneId] = useState(lanes[0]?.id ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const mounted = useRef(true);
  const live = useRef({ captions, items });
  live.current = { captions, items };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const importSrt = async (file: File) => {
    try {
      const words = identifyManualCues(parseSrt(await file.text()));
      if (!mounted.current) return;
      const patch = appendManualLane(live.current.captions, live.current.items);
      const added = patch.sourceEntries?.at(-1);
      if (!added) return;
      onUpdate({ ...patch, sourceEntries: patch.sourceEntries!.map((entry) => entry.id === added.id ? { ...entry, label: file.name, words } : entry) });
      setLaneId(added.id); setOpen(true); setImportError('');
    } catch (error) { if (mounted.current) setImportError(error instanceof Error ? error.message : t('SRT 导入失败')); }
  };
  useEffect(() => {
    if (!lanes.some((lane) => lane.id === laneId)) setLaneId(lanes[0]?.id ?? '');
  }, [lanes, laneId]);
  const addLane = () => {
    const patch = appendManualLane(captions, items);
    const lane = patch.sourceEntries?.filter(isManualCaptionEntry).at(-1);
    onUpdate(patch);
    if (lane) setLaneId(lane.id);
    setOpen(true);
  };
  const lane = lanes.find((candidate) => candidate.id === laneId) ?? lanes[0];
  return (
    <div className="cc-cap-bilingual">
      <input ref={inputRef} type="file" accept=".srt" hidden onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void importSrt(file);
      }} />
      {showSrtImport && <button type="button" className="cc-cap-btn" onClick={() => inputRef.current?.click()}>{t('导入 SRT 字幕')}</button>}
      {importError && <p className="cc-cap-error" role="alert">{importError}</p>}
      <button type="button" className="cc-cap-bilingual-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span>{t('手动字幕')}{lanes.length ? t('（{n} 车道）', { n: lanes.length }) : ''}</span>
        <span className="cc-cap-hint">{open ? t('收起') : t('展开')}</span>
      </button>
      {open && <ManualLanePanel {...{ captions, items, fps, lanes, lane, laneId, setLaneId, addLane, onUpdate, getPlayheadMs, onSeekMs, focusManualLane, onManualFocused, showCueList }} />}
    </div>
  );
}

interface LanePanelProps extends Props {
  lanes: CaptionSourceEntry[];
  lane?: CaptionSourceEntry;
  laneId: string;
  setLaneId: (id: string) => void;
  addLane: () => void;
}

function ManualLanePanel(props: LanePanelProps) {
  const { captions, items, fps, lanes, lane, laneId, setLaneId, addLane, onUpdate, getPlayheadMs, onSeekMs, focusManualLane, onManualFocused, showCueList } = props;
  const t = useT();
  return (
    <div className="cc-cap-bilingual-body">
      <div className="cc-cap-manual-toolbar">
        {lanes.length > 0 && <select className="cc-cap-select" value={laneId} onChange={(event) => setLaneId(event.target.value)}>
          {lanes.map((entry) => <option key={entry.id} value={entry.id}>{entry.label ?? t('手动字幕车道')}</option>)}
        </select>}
        <button type="button" className="cc-cap-btn sm" onClick={addLane}>{t('新建车道')}</button>
        {lane && <button type="button" className="cc-cap-btn sm ghost" onClick={() => onUpdate(removeManualLane(captions, lane.id))}>{t('删除车道')}</button>}
      </div>
      {!lane && <p className="cc-cap-hint">{t('新建车道后可在播放头添加字幕')}</p>}
      {lane && <ManualCueList key={lane.id} {...{ captions, items, fps, lane, onUpdate, getPlayheadMs, onSeekMs, focusManualLane, onManualFocused, showCueList }} />}
    </div>
  );
}

function ManualCueList({ captions, items, fps, lane, onUpdate, getPlayheadMs, onSeekMs, focusManualLane, onManualFocused, showCueList = true }: Props & { lane: CaptionSourceEntry }) {
  const t = useT();
  const composeRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusManualLane !== lane.id || !composeRef.current) return;
    composeRef.current.focus();
    onManualFocused?.();
  }, [focusManualLane, lane.id, onManualFocused]);
  const [text, setText] = useState('');
  const [start, setStart] = useState(() => ((getPlayheadMs?.() ?? 0) / 1000).toFixed(1));
  const [duration, setDuration] = useState('3.0');
  const [keyboardNotice, setKeyboardNotice] = useState('');
  const add = () => {
    const startMs = Number(start) * 1000;
    const patch = appendManualCue(captions, lane.id, text, startMs, startMs + Number(duration) * 1000);
    if (!patch) return;
    onUpdate(patch);
    setText('');
  };
  const syncPlayhead = () => setStart(((getPlayheadMs?.() ?? 0) / 1000).toFixed(1));
  const onComposeKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    event.preventDefault();
    add();
  };
  return (
    <div className="cc-cap-manual-compose">
      <textarea ref={composeRef} className="cc-cap-input cc-cap-textarea" rows={2} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onComposeKeyDown} placeholder={t('输入字幕文字')} />
      <div className="cc-cap-manual-controls">
        <label className="cc-cap-time-field"><span>{t('开始')}</span><input className="cc-cap-input" type="number" min="0" step="0.1" value={start} onChange={(event) => setStart(event.target.value)} /><span>s</span></label>
        <label className="cc-cap-time-field"><span>{t('时长')}</span><input className="cc-cap-input" type="number" min="0.1" step="0.1" value={duration} onChange={(event) => setDuration(event.target.value)} /><span>s</span></label>
        <button type="button" className="cc-cap-btn sm" onClick={syncPlayhead}>{t('取播放头')}</button>
        <button type="button" className="cc-cap-btn primary sm" disabled={!text.trim()} onClick={add}>{t('添加字幕')}</button>
      </div>
      {showCueList && <div className="cc-cap-manual-list">
        {(lane.words ?? []).map((cue, index) => <ManualCueRow key={cue.id ?? `${lane.id}_${cue.start}_${cue.end}_${index}`} {...{ captions, items, fps, lane, cue, index, onUpdate, onSeekMs, keyboardNotice, setKeyboardNotice }} />)}
      </div>}
      {keyboardNotice && <p className="cc-cap-hint" role="status">{keyboardNotice}</p>}
    </div>
  );
}

function ManualCueRow({ captions, items, fps, lane, cue, index, onUpdate, onSeekMs, setKeyboardNotice }: Props & { lane: CaptionSourceEntry; cue: TranscriptWord; index: number; keyboardNotice: string; setKeyboardNotice: (value: string) => void }) {
  const t = useT();
  const [text, setText] = useState(cue.text);
  const [start, setStart] = useState((cue.start / 1000).toFixed(1));
  const [end, setEnd] = useState((cue.end / 1000).toFixed(1));
  useEffect(() => {
    setText(cue.text); setStart((cue.start / 1000).toFixed(1)); setEnd((cue.end / 1000).toFixed(1));
  }, [cue.id, cue.text, cue.start, cue.end]);
  const save = () => {
    const rows = buildCues(captions, items, fps);
    const rowIndex = rows.findIndex((row) => row.manual && row.laneId === lane.id && row.manualIndex === index);
    const planned = planCaptionCueEdit({ captions, items, fps, rows, rowIndex, action: 'save', text,
      manualTiming: { startMs: Number(start) * 1000, endMs: Number(end) * 1000 } });
    const patch = planned.patch ?? updateManualCue(captions, lane.id, index, text, Number(start) * 1000, Number(end) * 1000);
    if (patch) onUpdate(patch);
  };
  const onTextKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const intent = captionCueKeyboardIntent({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      altKey: event.altKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode,
      selectionStart: event.currentTarget.selectionStart, selectionEnd: event.currentTarget.selectionEnd, textLength: event.currentTarget.value.length });
    if (intent === 'native') return;
    event.preventDefault();
    if (intent === 'save') { save(); return; }
    if (intent === 'selection') { setKeyboardNotice(t('请先取消文字选区，再将光标放在拆分位置。')); return; }
    const rows = buildCues(captions, items, fps);
    const rowIndex = rows.findIndex((row) => row.manual && row.laneId === lane.id && row.manualIndex === index);
    const request = { captions, items, fps, rows, rowIndex, action: intent, text,
      caret: event.currentTarget.selectionStart ?? 0, manualTiming: { startMs: Number(start) * 1000, endMs: Number(end) * 1000 } };
    const result = planCaptionCueEdit({ ...request, acceptMergeConflict: true });
    if (!result.patch) { setKeyboardNotice(result.reason ?? t('无法编辑这句字幕。')); return; }
    onUpdate(result.patch); setKeyboardNotice('');
  };
  return (
    <div className="cc-cap-manual-row">
      <input className="cc-cap-input" aria-label={t('开始秒数')} type="number" min="0" step="0.1" value={start} onChange={(event) => setStart(event.target.value)} onClick={() => onSeekMs?.(cue.start)} />
      <input className="cc-cap-input" aria-label={t('结束秒数')} type="number" min="0.1" step="0.1" value={end} onChange={(event) => setEnd(event.target.value)} />
      <input className="cc-cap-input cc-cap-manual-text" aria-label={t('字幕文字')} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onTextKeyDown} />
      <div className="cc-cap-manual-actions">
        <button type="button" className="cc-cap-btn sm" onClick={save}>{t('保存')}</button>
        <button type="button" className="cc-cap-btn sm ghost" onClick={() => onUpdate(removeManualCue(captions, lane.id, index))}>{t('删除')}</button>
      </div>
    </div>
  );
}
