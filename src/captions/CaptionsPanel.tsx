import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem, TrackId } from '../editor/types';
import { useT } from '../i18n/locale';
import { pickDefaultTrack, trackTitle, type TranscriptTrackOption } from '../transcript/trackOptions';
import { msToFrame } from '../transcript/types';
import { hasOperationalTranscript, type TranscriptWord } from '../transcript/types';
import { pastedSpeechItems, pastedRecognitionJobs, pastedTimingSnapshot, applyPastedRecognition } from './pastedTranscriptWorkflow';
import { useTranscript } from '../transcript/useTranscript';
import { buildPastedTranscriptTrack } from './pastedTranscriptTrack';
import { PastedTranscriptError, type PastedTranscriptErrorCode } from './pastedTranscript';
import { CaptionsControls } from './CaptionsControls';
import { identifyManualCues, newManualCaptions } from './manualCaptions';
import type { CaptionsData } from './types';
import { invokeAction } from '../shortcuts/actionRegistry';
import { isTranscriptionCancelled } from '../transcript/transcriptionCancellation';
import { localModelReadinessMessage } from '../transcript/localModelReadiness';
import { fmtCueMs } from './captionCues';
import { captionSelectionKey, type CaptionSelectOptions, type CaptionSelectionRef } from './captionSelection';
import './caption-list.css';
import { parseSrt } from './srt';

interface Props {
  projectId?: string;
  timelineId?: string;
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  trackOptions: TranscriptTrackOption[];
  captionTracks: Array<TranscriptTrackOption & { captions: CaptionsData | null }>;
  onSetCaptions: (captions: CaptionsData | null, track?: TrackId) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onLiveUpdateCaptions?: (patch: Partial<CaptionsData> | null, track?: TrackId) => void;
  onCreateCaptionTrack?: (captions: CaptionsData, opts?: { name?: string; order?: number }) => TrackId;
  selectedItem?: TimelineItem | null;
  openPasteTranscriptRequest?: number;
  onPasteRequestConsumed?: (nonce: number) => void;
  selectTrackRequest?: { trackId: TrackId; nonce: number };
  captionActivationRequest?: { selection: CaptionSelectionRef; nonce: number; identity: string };
  draftKey?: string;
  selectedCaptions?: readonly CaptionSelectionRef[];
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onSelectCaptionRange?: (selections: CaptionSelectionRef[], options: { additive: boolean; preserveWithItems: boolean }) => void;
  onSeekFrame?: (frame: number) => void;
  mode?: 'full' | 'generate-only' | 'list-only';
  onCaptionsReady?: (trackId?: TrackId) => void;
}

export function CaptionsPanel(props: Props) {
  const { playerRef, fps, items, trackOptions, captionTracks, onSetCaptions, onUpdateCaptions, onCreateCaptionTrack, selectedItem, openPasteTranscriptRequest = 0, mode = 'full', onCaptionsReady } = props;
  const t = useT();
  const [captionTrack, setCaptionTrack] = useState<TrackId | null>(() =>
    captionTracks.find((track) => track.captions)?.id ?? captionTracks[0]?.id ?? null);
  const [tab, setTab] = useState<'generate' | 'list'>(() => captionTracks.some((track) => track.captions) ? 'list' : 'generate');
  const [focusManualLane, setFocusManualLane] = useState<string | null>(null);
  const [playheadMs, setPlayheadMs] = useState(() => (playerRef.current?.getCurrentFrame() ?? 0) * 1000 / fps);
  const [playing, setPlaying] = useState(() => {
    try { return Boolean(playerRef.current?.isPlaying?.()); } catch { return false; }
  });
  const pendingTrack = useRef<TrackId | null>(null);
  const [pendingCaptionActivation, setPendingCaptionActivation] = useState<Props['captionActivationRequest']>();
  const selectedCaption = props.selectedCaptions?.at(-1);
  const selectedCaptionKey = captionSelectionKey(selectedCaption ?? null);
  useEffect(() => {
    if (selectedCaption) { setCaptionTrack(selectedCaption.trackId); setTab('list'); }
  }, [selectedCaptionKey]);
  useEffect(() => {
    if (!props.selectTrackRequest) return;
    pendingTrack.current = props.selectTrackRequest.trackId;
    setCaptionTrack(props.selectTrackRequest.trackId);
    setTab('list');
  }, [props.selectTrackRequest?.nonce]);
  useEffect(() => {
    const request = props.captionActivationRequest;
    if (!request || request.identity !== `${props.projectId ?? ''}:${props.timelineId ?? ''}`) {
      setPendingCaptionActivation(undefined);
      return;
    }
    pendingTrack.current = request.selection.trackId;
    setCaptionTrack(request.selection.trackId);
    setTab('list');
    setPendingCaptionActivation(request);
  }, [props.captionActivationRequest?.nonce]);
  const lastPasteRequest = useRef(0);
  useEffect(() => {
    if (openPasteTranscriptRequest <= lastPasteRequest.current) return;
    lastPasteRequest.current = openPasteTranscriptRequest;
    setTab('generate');
    props.onPasteRequestConsumed?.(openPasteTranscriptRequest);
  }, [openPasteTranscriptRequest]);
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let attachedPlayer: PlayerRef | null = null;
    const attach = (player: PlayerRef) => {
      attachedPlayer = player;
      let lastUpdate = 0;
      let pending: ReturnType<typeof setTimeout> | undefined;
      const syncPlaying = () => {
        try { setPlaying(Boolean(player.isPlaying?.())); } catch { setPlaying(false); }
      };
      const apply = (frame: number) => {
        lastUpdate = performance.now();
        setPlayheadMs(frame * 1000 / fps);
      };
      const onFrame = (event: { detail: { frame: number } }) => {
        const wait = 80 - (performance.now() - lastUpdate);
        if (wait <= 0) apply(event.detail.frame);
        else { clearTimeout(pending); pending = setTimeout(() => apply(event.detail.frame), wait); }
      };
      const onPlay = () => {
        setPlaying(true);
        apply(player.getCurrentFrame());
      };
      const onPause = () => {
        setPlaying(false);
        clearTimeout(pending);
        apply(player.getCurrentFrame());
      };
      const onSeeked = (event: { detail: { frame: number } }) => {
        clearTimeout(pending);
        apply(event.detail.frame);
      };
      syncPlaying();
      apply(player.getCurrentFrame());
      player.addEventListener('frameupdate', onFrame);
      player.addEventListener('play', onPlay);
      player.addEventListener('pause', onPause);
      player.addEventListener('seeked', onSeeked);
      cleanup = () => {
        clearTimeout(pending);
        player.removeEventListener('frameupdate', onFrame);
        player.removeEventListener('play', onPlay);
        player.removeEventListener('pause', onPause);
        player.removeEventListener('seeked', onSeeked);
      };
    };
    const ensureAttached = () => {
      const player = playerRef.current;
      if (player === attachedPlayer) return;
      cleanup?.();
      cleanup = undefined;
      attachedPlayer = null;
      if (player) attach(player);
    };
    ensureAttached();
    const poll = setInterval(ensureAttached, 150);
    return () => {
      clearInterval(poll);
      cleanup?.();
    };
  }, [playerRef, fps]);
  const [reviewRequest, setReviewRequest] = useState<{ ms: number; serial: number } | undefined>();
  const reviewSerial = useRef(0);
  const srtInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [srtError, setSrtError] = useState('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => setReviewRequest(undefined), [captionTrack]);
  const captions = captionTracks.find((option) => option.id === captionTrack)?.captions ?? null;
  useEffect(() => {
    if (!captionTrack || (!captionTracks.some((option) => option.id === captionTrack) && pendingTrack.current !== captionTrack)) setCaptionTrack(captionTracks[0]?.id ?? null);
    if (pendingTrack.current && captionTracks.some((option) => option.id === pendingTrack.current)) pendingTrack.current = null;
  }, [captionTrack, captionTracks]);
  const update = (patch: Partial<CaptionsData>) => onUpdateCaptions(patch, captionTrack ?? undefined);
  const set = (next: CaptionsData | null) => { onSetCaptions(next, captionTrack ?? undefined); setTab(next ? 'list' : 'generate'); };
  const importSrt = async (file: File) => {
    try {
      const words = identifyManualCues(parseSrt(await file.text()));
      if (!mounted.current || !onCreateCaptionTrack) return;
      const laneId = `srt_${crypto.randomUUID()}`;
      const track = onCreateCaptionTrack({ ...newManualCaptions(), sourceEntries: [{ id: laneId, itemId: `manual:${laneId}`, label: file.name, words }] },
        { name: file.name.replace(/\.srt$/i, '') || file.name });
      pendingTrack.current = track; setCaptionTrack(track); setTab('list'); setSrtError('');
      onCaptionsReady?.(track);
    } catch (error) { if (mounted.current) setSrtError(error instanceof Error ? error.message : t('SRT 导入失败')); }
  };
  const effectiveTab = mode === 'generate-only' ? 'generate' : mode === 'list-only' ? 'list' : tab;
  const seekToMs = (ms: number) => {
    playerRef.current?.pause();
    const targetFrame = msToFrame(ms, fps);
    if (props.onSeekFrame) props.onSeekFrame(targetFrame);
    else playerRef.current?.seekTo(targetFrame);
  };
  return (
    <div className="cc-captions-workspace" data-view={effectiveTab}>
      <div className="cc-captions-context">
        <CaptionTrackBar options={captionTracks} track={captionTrack} onChange={(track) => { setCaptionTrack(track); setReviewRequest(undefined); props.onSelectCaption?.(null); }}
          onImportSrt={mode !== 'list-only' && onCreateCaptionTrack ? () => srtInput.current?.click() : undefined} />
        {mode !== 'list-only' && onCreateCaptionTrack && <input ref={srtInput} type="file" accept=".srt" hidden onChange={(event) => {
          const file = event.target.files?.[0]; event.target.value = ''; if (file) void importSrt(file);
        }} />}
      </div>
      {mode === 'full' && <div className="cc-caption-workspace-tabs" role="tablist" aria-label={t('字幕工作区')}>
        <button type="button" role="tab" aria-selected={tab === 'generate'} onClick={() => setTab('generate')}>{t('生成字幕')}</button>
        <button type="button" role="tab" aria-selected={tab === 'list'} onClick={() => setTab('list')}>{t('字幕列表')}</button>
      </div>}
      {srtError && <p className="cc-cap-error" role="alert">{srtError}</p>}
      {mode !== 'list-only' && onCreateCaptionTrack && <PasteTranscriptBox showComposer={effectiveTab === 'generate'} key={props.draftKey} draftKey={props.draftKey} activeCaptionTrack={captionTrack} activeCaptions={captions} items={items} fps={fps} trackOptions={trackOptions} selectedItem={selectedItem} existingNames={captionTracks.map((track) => track.name ?? track.alias)} onCreate={onCreateCaptionTrack} onSeekMs={(ms) => { seekToMs(ms); setReviewRequest({ ms, serial: ++reviewSerial.current }); setTab('list'); onCaptionsReady?.(captionTrack ?? undefined); }} onSelect={(track) => { pendingTrack.current = track; setCaptionTrack(track); setReviewRequest(undefined); setTab('list'); onCaptionsReady?.(track); }} openRequest={openPasteTranscriptRequest} />}
      <CaptionsControls projectId={props.projectId} timelineId={props.timelineId} draftKey={props.draftKey} showList={effectiveTab === 'list'} showStyleDetails={mode !== 'list-only'} playheadMs={playheadMs} playing={playing} selectedCaptions={props.selectedCaptions} captionActivationRequest={pendingCaptionActivation} onCaptionActivationConsumed={(nonce) => setPendingCaptionActivation((current) => current?.nonce === nonce ? undefined : current)} onSelectCaption={props.onSelectCaption} onSelectCaptionRange={props.onSelectCaptionRange} key={captionTrack} captionTrackId={captionTrack ?? undefined} captions={captions} reviewRequest={reviewRequest} sourceVariants={(captions?.sourceItemId ? items.find((item) => item.id === captions.sourceItemId)?.variants : undefined) ?? []} items={items} fps={fps} onSeekMs={seekToMs} onCreateManual={() => { const next = newManualCaptions(); setFocusManualLane(next.sourceEntries?.[0]?.id ?? null); set(next); }} focusManualLane={focusManualLane} onManualFocused={() => setFocusManualLane(null)} getPlayheadMs={() => ((playerRef.current?.getCurrentFrame() ?? 0) / fps) * 1000} onUpdate={update} onLiveUpdate={props.onLiveUpdateCaptions ? (patch) => props.onLiveUpdateCaptions?.(patch, captionTrack ?? undefined) : undefined} onRemove={() => set(null)} />
    </div>
  );
}

const PASTED_TRANSCRIPT_ERROR_KEYS: Record<PastedTranscriptErrorCode, string> = {
  'empty-script': '请先粘贴文字稿。',
  'missing-timing': '当前轨道没有可用的转写时间，请先进行本机转写。',
  'no-matchable-text': '文字稿里没有可用于匹配的文字或数字。',
};

export function PasteTranscriptBox({ items, fps, trackOptions, selectedItem, existingNames, onCreate, onSelect, onSeekMs, activeCaptionTrack, activeCaptions, draftKey, openRequest = 0, showComposer = true }: { items: TimelineItem[]; fps: number; trackOptions: TranscriptTrackOption[]; selectedItem?: TimelineItem | null; existingNames: string[]; onCreate: (captions: CaptionsData, opts?: { name?: string }) => TrackId; onSelect?: (track: TrackId) => void; onSeekMs?: (ms: number) => void; activeCaptionTrack?: TrackId | null; activeCaptions?: CaptionsData | null; openRequest?: number; draftKey?: string; showComposer?: boolean }) {
  const t = useT();
  const [text, setText] = useState(() => {
    try { return draftKey ? sessionStorage.getItem(`cc-caption-draft:${draftKey}`) ?? '' : ''; } catch { return ''; }
  });
  const [open, setOpen] = useState(Boolean(text));
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (text) sessionStorage.setItem(`cc-caption-draft:${draftKey}`, text);
      else sessionStorage.removeItem(`cc-caption-draft:${draftKey}`);
    } catch { /* The visible draft is still usable if storage is unavailable. */ }
  }, [draftKey, text]);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [reviewCues, setReviewCues] = useState<TranscriptWord[]>([]);
  const reviewTrack = useRef<TrackId | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const speechItems = pastedSpeechItems;
  const speechTracks = trackOptions.filter((track) => speechItems(items, track.id).length > 0);
  const transcript = useTranscript();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const liveItems = useRef(items);
  liveItems.current = items;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cancelled.current = true; transcript.cancel(); }; }, [transcript.cancel]);
  const selectedTrackDefault = selectedItem && speechTracks.some((track) => track.id === selectedItem.track)
    ? selectedItem.track
    : pickDefaultTrack(speechTracks, items);
  const [speechTrack, setSpeechTrack] = useState<TrackId | null>(selectedTrackDefault);
  useEffect(() => {
    if (!speechTrack || !speechTracks.some((track) => track.id === speechTrack)) setSpeechTrack(selectedTrackDefault);
  }, [selectedTrackDefault, speechTrack, speechTracks]);
  useEffect(() => {
    if (openRequest <= 0) return;
    setWarning(null);
    setError(null);
    setOpen(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [openRequest]);
  const needsTiming = Boolean(speechTrack && speechItems(items, speechTrack).some((item) => !hasOperationalTranscript(item)));
  useEffect(() => {
    if (!showComposer || !open || !needsTiming) return;
    const controller = new AbortController();
    void transcript.checkModel(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [showComposer, open, needsTiming, transcript.checkModel]);
  const currentWords = useMemo(() => activeCaptions?.sourceEntries
    ? new Map(activeCaptions.sourceEntries.flatMap((entry) => (entry.words ?? []).map((word) => [word.id, word] as const)))
    : undefined, [activeCaptions]);
  const visibleReviewCues = currentWords ? reviewCues.flatMap((cue) => {
    const current = currentWords.get(cue.id);
    return current ? [current] : [];
  }) : reviewCues;
  const review = visibleReviewCues.length > 0 && (activeCaptionTrack === undefined || activeCaptionTrack === reviewTrack.current) && <div className="cc-cap-field" aria-label={t('需要核对的字幕')}>
    <div className="cc-cap-label">{t('需要核对的句子')} ({visibleReviewCues.length})</div>
    <p className="cc-cap-hint">{t('以下句子与识别差异较大，点击定位修改')}</p>
    <div className="cc-cap-cue-list">
      {visibleReviewCues.map((cue, index) => <button type="button" key={cue.id ?? `${cue.start}:${index}`} className="cc-cap-btn" style={{ fontSize: 14, textAlign: 'left' }} onClick={() => onSeekMs?.(cue.start)}>{fmtCueMs(cue.start)} · {cue.text}</button>)}
    </div>
    <button type="button" className="cc-cap-btn ghost" onClick={() => setReviewCues([])}>{t('收起核对提示')}</button>
  </div>;
  if (!showComposer) return <>{warning && <div className="cc-cap-hint warn" role="status">{warning}</div>}{review}{busy && <div className="cc-cap-field" role="status">{transcript.progressNote ?? t('正在生成字幕…')}<button type="button" className="cc-cap-btn" onClick={() => { cancelled.current = true; transcript.cancel(); }}>{t('取消生成')}</button></div>}</>;
  if (!open) return <>{warning && <div className="cc-cap-hint warn" role="status">{warning}</div>}{review}<button type="button" className="cc-cap-btn" onClick={() => { setWarning(null); setOpen(true); }}>{t('粘贴文字稿生成字幕')}</button></>;
  const run = async () => {
    if (running.current || !text.trim()) return;
    setError(null); setWarning(null);
    if (!speechTrack) { setError(t('没有可用的口播轨道，请先对视频或音频进行本机转写。')); return; }
    running.current = true; cancelled.current = false; setBusy(true); transcript.reset();
    try {
      const source = speechItems(items, speechTrack);
      const jobs = pastedRecognitionJobs(source);
      const recognized = new Map<string, TranscriptWord[]>();
      const snapshot = pastedTimingSnapshot(items, speechTrack);
      const unchanged = () => mounted.current && !cancelled.current && snapshot === pastedTimingSnapshot(liveItems.current, speechTrack);
      if (jobs.length) await transcript.runMany(jobs, (id, result) => {
        if (!unchanged()) return;
        for (const clip of jobs.find((job) => job.itemId === id)!.clips) recognized.set(clip.id, result.words);
      });
      if (cancelled.current) return;
      if (!unchanged()) throw new Error(t('识别期间剪辑内容已改变，请确认当前轨道后重新生成；文字稿已保留。'));
      const timedItems = applyPastedRecognition(liveItems.current, recognized);
      if (speechItems(timedItems, speechTrack).some((item) => !hasOperationalTranscript(item))) {
        throw new Error(t('部分片段未获得口播时间，请检查声音或本机识别模型后重试；文字稿已保留。'));
      }
      const laneId = `lane_${crypto.randomUUID()}`;
      const base = t('文字稿字幕'); let name = base; let n = 2;
      while (existingNames.includes(name)) name = `${base} ${n++}`;
      const result = buildPastedTranscriptTrack({ script: text, items: timedItems, fps, track: speechTrack, laneId, label: name });
      const trackId = onCreate(result.captions, { name });
      reviewTrack.current = trackId;
      onSelect?.(trackId);
      setReviewCues(result.alignment.reviewCueIndices.map((index) => result.alignment.cues[index]!));
      setOpen(false); setText('');
      if (result.alignment.reviewCueIndices.length) setWarning(t('已生成字幕；下面列出了需要核对的句子，可直接点句子定位。'));
    } catch (cause) {
      if (!mounted.current) return;
      if (cancelled.current || isTranscriptionCancelled(cause)) return;
      if (cause instanceof PastedTranscriptError) setError(t(PASTED_TRANSCRIPT_ERROR_KEYS[cause.code]));
      else setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="cc-cap-field">
    <div className="cc-cap-label">{t('粘贴文字稿生成字幕')}</div>
    {!speechTracks.length && <div className="cc-cap-hint">{t('口播在子草稿里时，双击时间线上的子草稿，进入后生成字幕。')}</div>}
    {needsTiming && <div className="cc-cap-hint" role="status" style={{ fontSize: 14 }}>
      {transcript.modelReadiness ? t(localModelReadinessMessage(transcript.modelReadiness)) : t('正在检查本机识别模型；生成前会再次确认。')}
      <div className="cc-cap-row-actions">
        <button type="button" className="cc-cap-btn ghost" disabled={busy} onClick={() => { void transcript.checkModel().catch(() => {}); }}>{t('重新检查模型')}</button>
        {transcript.modelReadiness?.state !== 'ready' && <button type="button" className="cc-cap-btn" disabled={busy} onClick={() => invokeAction('open-settings', undefined, 'toolbar')}>{t('设置本机识别')}</button>}
      </div>
    </div>}
    <label className="cc-cap-label" htmlFor="cc-pasted-transcript-track">{t('口播轨道')}</label>
    <select id="cc-pasted-transcript-track" className="cc-cap-select" value={speechTrack ?? ''} disabled={busy || !speechTracks.length} onChange={(event) => setSpeechTrack(event.target.value)}>
      {!speechTracks.length && <option value="">{t('请先把口播视频或音频拖入时间线')}</option>}
      {speechTracks.map((track) => <option key={track.id} value={track.id}>{trackTitle(track)}</option>)}
    </select>
    <textarea ref={textareaRef} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} rows={7} className="cc-cap-textarea" placeholder={t('在这里粘贴完整口播稿，按句或约20字自动分成一条字幕')} />
    <div className="cc-cap-row-actions">
      <button type="button" className="cc-cap-btn primary" disabled={busy || !text.trim() || !speechTrack} onClick={() => { void run(); }}>{t(busy ? '正在识别口播时间…' : needsTiming ? '识别时间并生成字幕' : '生成字幕')}</button>
      {busy && <button type="button" className="cc-cap-btn" onClick={() => { cancelled.current = true; transcript.cancel(); setWarning(t('已取消生成；文字稿已保留，可以修改后重试。')); }}>{t('取消生成')}</button>}
      <button type="button" className="cc-cap-btn ghost" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>{t('收起')}</button>
    </div>
    {busy && <div className="cc-cap-hint" role="status">{transcript.progressNote ?? t('正在处理，请稍候…')}</div>}
    {(error || transcript.error) && <div className="cc-cap-error" role="alert">
      {[error, transcript.error].filter((message, index, messages) => message && messages.indexOf(message) === index).join('；')}
      <button type="button" className="cc-cap-btn" onClick={() => invokeAction('open-settings', undefined, 'toolbar')}>{t('设置本机识别')}</button>
    </div>}
    {warning && <div className="cc-cap-hint warn">{warning}</div>}
    {review}
  </div>;
}

function CaptionTrackBar({ options, track, onChange, onImportSrt }: {
  options: Props['captionTracks']; track: TrackId | null; onChange: (track: TrackId) => void; onImportSrt?: () => void;
}) {
  const t = useT();
  return (
    <div className="cc-captions-sourcebar">
      <label htmlFor="cc-caption-track">{t('字幕轨道')}</label>
      <select id="cc-caption-track" className="cc-cap-select" value={track ?? ''} disabled={!options.length} onChange={(event) => onChange(event.target.value)}>
        {!options.length && <option value="">{t('暂无字幕轨道')}</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{trackTitle(option)}</option>)}
      </select>
      {onImportSrt && <button type="button" className="cc-cap-btn sm" title={t('导入 SRT 字幕')} onClick={onImportSrt}>{t('导入 SRT')}</button>}
    </div>
  );
}
