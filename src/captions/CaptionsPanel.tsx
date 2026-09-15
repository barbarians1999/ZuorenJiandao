import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineItem, TrackId } from '../editor/types';
import { useT } from '../i18n/locale';
import { pickDefaultTrack, trackTitle, type TranscriptTrackOption } from '../transcript/trackOptions';
import { msToFrame } from '../transcript/types';
import { buildPastedTranscriptTrack, transcribedSpeechOnTrack } from './pastedTranscriptTrack';
import { CaptionsControls } from './CaptionsControls';
import { newManualCaptions } from './manualCaptions';
import { buildTranslation } from './translate';
import type { CaptionsData } from './types';

interface Props {
  playerRef: RefObject<PlayerRef | null>;
  fps: number;
  items: TimelineItem[];
  trackOptions: TranscriptTrackOption[];
  captionTracks: Array<TranscriptTrackOption & { captions: CaptionsData | null }>;
  onSetCaptions: (captions: CaptionsData | null, track?: TrackId) => void;
  onUpdateCaptions: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onCreateCaptionTrack?: (captions: CaptionsData, opts?: { name?: string; order?: number }) => TrackId;
  selectedItem?: TimelineItem | null;
}

export function CaptionsPanel(props: Props) {
  const { playerRef, fps, items, trackOptions, captionTracks, onSetCaptions, onUpdateCaptions, onCreateCaptionTrack, selectedItem } = props;
  const [captionTrack, setCaptionTrack] = useState<TrackId | null>(captionTracks[0]?.id ?? null);
  const pendingTrack = useRef<TrackId | null>(null);
  const captions = captionTracks.find((option) => option.id === captionTrack)?.captions ?? null;
  useEffect(() => {
    if (!captionTrack || (!captionTracks.some((option) => option.id === captionTrack) && pendingTrack.current !== captionTrack)) setCaptionTrack(captionTracks[0]?.id ?? null);
    if (pendingTrack.current && captionTracks.some((option) => option.id === pendingTrack.current)) pendingTrack.current = null;
  }, [captionTrack, captionTracks]);
  const update = (patch: Partial<CaptionsData>) => onUpdateCaptions(patch, captionTrack ?? undefined);
  const set = (next: CaptionsData | null) => onSetCaptions(next, captionTrack ?? undefined);
  const translation = useCaptionTranslation(captions, items, fps, update);
  return (
    <div className="cc-captions-workspace">
      <div className="cc-captions-context">
        <CaptionTrackBar options={captionTracks} track={captionTrack} onChange={setCaptionTrack} />
      </div>
      {onCreateCaptionTrack && <PasteTranscriptBox items={items} fps={fps} trackOptions={trackOptions} selectedItem={selectedItem} existingNames={captionTracks.map((track) => track.name ?? track.alias)} onCreate={onCreateCaptionTrack} onSelect={(track) => { pendingTrack.current = track; setCaptionTrack(track); }} />}
      <CaptionsControls captionTrackId={captionTrack ?? undefined} captions={captions} sourceVariants={(captions?.sourceItemId ? items.find((item) => item.id === captions.sourceItemId)?.variants : undefined) ?? []} items={items} fps={fps} onSeekMs={(ms) => playerRef.current?.seekTo(msToFrame(ms, fps))} onCreateManual={() => set(newManualCaptions())} getPlayheadMs={() => ((playerRef.current?.getCurrentFrame() ?? 0) / fps) * 1000} onUpdate={update} onRemove={() => set(null)} onTranslate={translation.run} translating={translation.running} translateError={translation.error} />
    </div>
  );
}

function PasteTranscriptBox({ items, fps, trackOptions, selectedItem, existingNames, onCreate, onSelect }: { items: TimelineItem[]; fps: number; trackOptions: TranscriptTrackOption[]; selectedItem?: TimelineItem | null; existingNames: string[]; onCreate: (captions: CaptionsData, opts?: { name?: string }) => TrackId; onSelect?: (track: TrackId) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const speechTracks = trackOptions.filter((track) => transcribedSpeechOnTrack(items, track.id).length > 0);
  const selectedTrackDefault = selectedItem && speechTracks.some((track) => track.id === selectedItem.track)
    ? selectedItem.track
    : pickDefaultTrack(speechTracks, items);
  const [speechTrack, setSpeechTrack] = useState<TrackId | null>(selectedTrackDefault);
  useEffect(() => {
    if (!speechTrack || !speechTracks.some((track) => track.id === speechTrack)) setSpeechTrack(selectedTrackDefault);
  }, [selectedTrackDefault, speechTrack, speechTracks]);
  if (!open) return <>{warning && <div className="cc-cap-hint warn">{warning}</div>}<button type="button" className="cc-cap-btn" onClick={() => { setWarning(null); setOpen(true); }}>{t('粘贴文字稿生成字幕')}</button></>;
  const run = () => {
    setError(null); setWarning(null);
    if (!speechTrack) { setError(t('没有可用的口播轨道，请先对视频或音频进行本机转写。')); return; }
    try {
      const laneId = `lane_${crypto.randomUUID()}`;
      const base = t('文字稿字幕'); let name = base; let n = 2;
      while (existingNames.includes(name)) name = `${base} ${n++}`;
      const result = buildPastedTranscriptTrack({ script: text, items, fps, track: speechTrack, laneId, label: name });
      const trackId = onCreate(result.captions, { name });
      onSelect?.(trackId);
      setOpen(false); setText('');
      if (result.alignment.weak) setWarning(t('已生成，但文字稿与识别结果差异较大，请检查开头、中段和结尾。'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="cc-cap-field"><div className="cc-cap-label">{t('粘贴完整文字稿')}</div><div className="cc-cap-hint">{t('先本机转写，声音定时间，粘贴稿定文字。建议完成剪辑后再生成；新字幕不会覆盖识别结果或已有字幕。')}</div><label className="cc-cap-label" htmlFor="cc-pasted-transcript-track">{t('口播轨道')}</label><select id="cc-pasted-transcript-track" className="cc-cap-select" value={speechTrack ?? ''} disabled={!speechTracks.length} onChange={(event) => setSpeechTrack(event.target.value)}>{!speechTracks.length && <option value="">{t('没有已转写的口播轨道')}</option>}{speechTracks.map((track) => <option key={track.id} value={track.id}>{trackTitle(track)}</option>)}</select><textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} className="cc-cap-textarea" placeholder={t('在这里粘贴完整口播稿，按句或约20字自动分成一条字幕')} /><div className="cc-cap-row-actions"><button type="button" className="cc-cap-btn primary" disabled={!text.trim() || !speechTrack} onClick={run}>{t('生成独立字幕轨')}</button><button type="button" className="cc-cap-btn ghost" onClick={() => { setOpen(false); setError(null); }}>{t('取消')}</button></div>{error && <div className="cc-cap-error">{error}</div>}{warning && <div className="cc-cap-hint warn">{warning}</div>}</div>;
}

function CaptionTrackBar({ options, track, onChange }: { options: Props['captionTracks']; track: TrackId | null; onChange: (track: TrackId) => void }) {
  const t = useT();
  return (
    <div className="cc-captions-sourcebar">
      <label htmlFor="cc-caption-track">{t('字幕轨道')}</label>
      <select id="cc-caption-track" className="cc-cap-select" value={track ?? ''} disabled={!options.length} onChange={(event) => onChange(event.target.value)}>
        {!options.length && <option value="">{t('请先新建字幕轨道')}</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{trackTitle(option)}</option>)}
      </select>
    </div>
  );
}

function useCaptionTranslation(captions: CaptionsData | null, items: TimelineItem[], fps: number, onUpdate: (patch: Partial<CaptionsData>) => void) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (lang: string) => {
    if (!captions || running) return;
    setRunning(true);
    setError(null);
    try {
      const { cues, fingerprint } = await buildTranslation(captions, items, fps, lang);
      onUpdate({
        bilingual: true, translationLang: lang, translation: cues,
        translationFingerprint: fingerprint,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };
  return { running, error, run };
}
