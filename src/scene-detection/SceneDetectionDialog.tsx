import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { EditorCommands } from '../editor/store';
import type { TimelineItem, TimelineState } from '../editor/types';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { mapScenesToItem, planSceneSplits, sceneAnalysisIdentity, sceneDetectionUnavailable,
  sceneMarkerActions, sceneRequestRange } from './apply';
import { getSceneDetectionJob, type SceneDetectionJobSnapshot } from './jobs';
import { SceneDetectionSession, sceneJobActive } from './session';
import './scene-detection.css';

interface SceneDetectionDialogProps {
  state: TimelineState;
  commands: EditorCommands;
  item: TimelineItem;
  onPreviewCut?: (frame: number) => void;
  onClose: () => void;
}

const PRESETS = [{ label: '较少', threshold: 0.45 }, { label: '标准', threshold: 0.3 }, { label: '较多', threshold: 0.18 }] as const;
function formatTime(timeMs: number): string {
  const seconds = Math.max(0, timeMs) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

export function SceneDetectionDialog({ state, commands, item, onPreviewCut, onClose }: SceneDetectionDialogProps) {
  const t = useT();
  const [threshold, setThreshold] = useState(0.3);
  const [minSceneSeconds, setMinSceneSeconds] = useState(0.75);
  const [maxScenes, setMaxScenes] = useState(200);
  const [job, setJob] = useState<SceneDetectionJobSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<'markers' | 'split' | null>(null);
  const [selectedTimes, setSelectedTimes] = useState<Set<number>>(new Set());
  const [inspecting, setInspecting] = useState<number | null>(null);
  const sessionRef = useRef(new SceneDetectionSession());
  const sectionRef = useRef<HTMLElement | null>(null);
  const originalTimelineId = useRef((state as TimelineState & { id?: string }).id);
  const stateRef = useRef(state); stateRef.current = state;
  const analysisIdentity = useRef<string | null>(null);
  const liveState = () => commands.getState?.() ?? stateRef.current;
  const running = submitting || sceneJobActive(job);
  const unavailable = sceneDetectionUnavailable(state, item);
  const identityMatches = !analysisIdentity.current || sceneAnalysisIdentity(state, item) === analysisIdentity.current;
  const evidence = useMemo(() => job?.result?.scenes ?? [], [job?.result?.scenes]);
  const mapped = useMemo(() => mapScenesToItem(evidence, item, state.fps), [evidence, item, state.fps]);
  const chosen = mapped.filter((scene) => selectedTimes.has(scene.timeMs));
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    const session = new SceneDetectionSession();
    sessionRef.current = session;
    return () => { void session.close().catch(() => undefined); };
  }, []);

  useEffect(() => {
    if (!jobId || !sceneJobActive(job)) return;
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await getSceneDetectionJob(jobId);
        if (disposed || !sessionRef.current.accept(next)) return;
        setJob(next);
        if (sceneJobActive(next)) timer = window.setTimeout(() => void poll(), 400);
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : String(cause));
          timer = window.setTimeout(() => void poll(), 1500);
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 400);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [jobId, jobStatus]);

  useEffect(() => {
    if (job?.status === 'completed') setSelectedTimes(new Set(job.result?.scenes.map((scene) => scene.timeMs) ?? []));
  }, [jobId, jobStatus]);
  useEffect(() => {
    if (inspecting !== null) sectionRef.current?.querySelector<HTMLButtonElement>('.cc-scene-inspecting button')?.focus();
  }, [inspecting]);

  const start = async () => {
    const snapshot = liveState();
    if ((snapshot as TimelineState & { id?: string }).id !== originalTimelineId.current) {
      setError(t('当前子草稿已切换，请关闭后重新选择视频')); return;
    }
    const current = snapshot.items.find((entry) => entry.id === item.id);
    const reason = sceneDetectionUnavailable(snapshot, current ?? null);
    if (!current || reason) { setError(t(reason ?? '当前视频片段已不存在，请重新选择')); return; }
    const range = sceneRequestRange(current, snapshot.fps);
    if (!range) { setError(t('当前片段的速度或素材范围无法分析')); return; }
    const session = sessionRef.current;
    if (session.isPending || running) return;
    analysisIdentity.current = sceneAnalysisIdentity(snapshot, current);
    setError(null); setApplied(null); setInspecting(null); setJob(null); setSelectedTimes(new Set()); setCancelled(false);
    setSubmitting(true);
    try {
      const created = await session.start({ src: current.src!, ...range, threshold,
        minSceneMs: Math.round(minSceneSeconds * 1000), maxScenes });
      if (!session.isClosed && session === sessionRef.current && created) setJob(created);
    } catch (cause) {
      if (!session.isClosed && session === sessionRef.current) {
        if (session.snapshot) setJob(session.snapshot);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (!session.isClosed && session === sessionRef.current) { setSubmitting(false); setCancelling(false); }
    }
  };

  const cancel = async () => {
    const session = sessionRef.current;
    setCancelling(true);
    setCancelled(true);
    try {
      const next = await session.cancel();
      if (!session.isClosed && next) setJob(next);
    } catch (cause) {
      if (!session.isClosed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (!session.isClosed && !session.isPending) setCancelling(false); }
  };
  const close = () => { void sessionRef.current.close().catch(() => undefined); onClose(); };
  const apply = (mode: 'markers' | 'split') => {
    if (job?.status !== 'completed' || applied) return;
    const snapshot = liveState();
    const current = snapshot.items.find((entry) => entry.id === item.id);
    const reason = sceneDetectionUnavailable(snapshot, current ?? null);
    if (!current || reason) { setError(t(reason ?? '当前视频片段已不存在，请重新选择')); return; }
    if (sceneAnalysisIdentity(snapshot, current) !== analysisIdentity.current) {
      setError(t('片段或素材范围已改变，请重新检测')); return;
    }
    const selected = mapScenesToItem(evidence, current, snapshot.fps).filter((scene) => selectedTimes.has(scene.timeMs));
    if (!selected.length) { setError(t('请至少选择一个可用切点')); return; }
    if (mode === 'markers') commands.batch(sceneMarkerActions(current, selected), 'Add scene markers');
    else {
      const plan = planSceneSplits(snapshot, current.id, selected);
      if (!plan.ok) { setError(t(plan.error)); return; }
      commands.batch([{ type: 'setFullState', state: plan.state }], 'Split clip at scene changes');
    }
    setApplied(mode); setError(null); setInspecting(null);
  };
  const preview = (timeMs: number) => {
    const snapshot = liveState();
    const current = snapshot.items.find((entry) => entry.id === item.id);
    if (!current || sceneAnalysisIdentity(snapshot, current) !== analysisIdentity.current) {
      setError(t('片段或素材范围已改变，请重新检测')); return;
    }
    const scene = mapScenesToItem(evidence, current, snapshot.fps).find((entry) => entry.timeMs === timeMs);
    if (scene && onPreviewCut) { onPreviewCut(scene.timelineFrame); setInspecting(timeMs); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); inspecting !== null ? setInspecting(null) : close(); }
    if (event.key !== 'Tab' || inspecting !== null) return;
    const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')]
      .filter((entry) => entry.getClientRects().length > 0);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const phase = cancelling ? t('正在取消检测') : submitting ? t('正在创建检测任务') : job ? ({
    queued: t('等待检测'), probing: t('分析素材信息'), detecting: t('检测场景变化'), finalizing: t('整理检测结果'),
    completed: t('检测完成'), failed: t('检测失败'), cancelled: t('已取消'),
  } as const)[job.status] : cancelled ? t('已取消') : t('尚未开始');
  const canApply = job?.status === 'completed' && chosen.length > 0 && !applied && !unavailable && identityMatches;
  const failure = error ?? job?.error;

  return createPortal(<div className={`cc-scene-overlay${inspecting !== null ? ' is-inspecting' : ''}`} role="dialog" aria-modal={inspecting === null}
    aria-labelledby="cc-scene-title" onClick={running ? undefined : close}>
    <section ref={sectionRef} className="cc-scene-dialog" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
      <header className="cc-scene-header"><div><h2 id="cc-scene-title">{t('智能分割镜头')}</h2>
        <p>{item.name} · {t('只分析当前片段，本机处理')}</p></div>
        <button type="button" autoFocus className="cc-scene-icon-button" onClick={close} aria-label={t('关闭')}><Icon name="x" size={20} /></button>
      </header>
      {inspecting !== null && <div className="cc-scene-inspecting"><p>{t('正在预览切点 {time}', { time: formatTime(inspecting) })}</p>
        <p>{t('主预览显示当前工程的真实画面，切点选择保持不变。')}</p>
        <button type="button" className="cc-scene-button secondary" onClick={() => setInspecting(null)}>{t('返回切点列表')}</button></div>}
      <div className="cc-scene-body">
        <aside className="cc-scene-options">
          <fieldset className="cc-scene-presets"><legend>{t('分割数量')}</legend><div>{PRESETS.map((preset) =>
            <button type="button" key={preset.label} disabled={running} aria-pressed={threshold === preset.threshold}
              onClick={() => setThreshold(preset.threshold)}>{t(preset.label)}</button>)}</div><small>{t('标准适合多数视频；多会保留更多可能的镜头变化。')}</small></fieldset>
          <details className="cc-scene-advanced"><summary>{t('高级设置')}</summary>
            <label><span>{t('检测阈值')}</span><strong>{threshold.toFixed(2)}</strong><input type="range" min={0.05} max={0.95} step={0.01}
              value={threshold} disabled={running} onChange={(event) => setThreshold(Number(event.target.value))} /><small>{t('数值越低，检测到的切点越多')}</small></label>
            <label><span>{t('最短镜头间隔')}</span><strong>{minSceneSeconds.toFixed(2)}s</strong><input type="range" min={0.1} max={10} step={0.05}
              value={minSceneSeconds} disabled={running} onChange={(event) => setMinSceneSeconds(Number(event.target.value))} /></label>
            <label><span>{t('最多切点')}</span><input className="cc-scene-number" type="number" min={1} max={500} value={maxScenes} disabled={running}
              onChange={(event) => setMaxScenes(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} /></label>
          </details>
          <div className="cc-scene-progress-card"><div><span>{phase}</span>{job && <strong>{Math.round(job.progress * 100)}%</strong>}</div>
            {job && <div className="cc-scene-progress-track"><i style={{ transform: `scaleX(${job.progress})` }} /></div>}
            {job?.status === 'detecting' && <small>{t('已分析到 {time}', { time: formatTime(job.processedMs) })}</small>}</div>
          {running ? <button type="button" className="cc-scene-button secondary" disabled={cancelling} onClick={() => void cancel()}>{t('取消检测')}</button>
            : <button type="button" className="cc-scene-button primary" disabled={!!unavailable} onClick={() => void start()}>{job ? t('重新检测') : t('开始检测')}</button>}
          {unavailable && <p className="cc-scene-error">{t(unavailable)}</p>}
          {!identityMatches && !applied && <p className="cc-scene-error">{t('片段或素材范围已改变，请重新检测')}</p>}
          {failure && <p className="cc-scene-error" role="alert">{failure}</p>}
        </aside>
        <main className="cc-scene-results"><div className="cc-scene-results-header"><div><h3>{t('选择要分割的切点')}</h3>
          <p>{job?.status === 'completed' ? t('当前片段发现 {all} 个切点，已选 {selected} 个', { all: mapped.length, selected: chosen.length })
            : t('检测后勾选切点，查看画面，再确认分割。')}</p></div>
          {job?.status === 'completed' && <div className="cc-scene-selection"><button type="button" disabled={!!applied} onClick={() => setSelectedTimes(new Set(mapped.map((scene) => scene.timeMs)))}>{t('全选')}</button>
            <button type="button" disabled={!!applied} onClick={() => setSelectedTimes(new Set())}>{t('取消全选')}</button></div>}</div>
          <div className="cc-scene-list">{job?.status !== 'completed' && <div className="cc-scene-empty"><Icon name="film" size={28} /><span>{running ? t('正在分析当前片段…') : t('点击开始检测')}</span></div>}
            {job?.status === 'completed' && mapped.length === 0 && <div className="cc-scene-empty"><Icon name="check" size={28} /><span>{t('当前片段没有发现镜头切点，可以选择“多”后重新检测。')}</span></div>}
            {mapped.map((scene, index) => { const images = evidence.find((entry) => entry.timeMs === scene.timeMs)!; return <article className="cc-scene-row" key={scene.timeMs}>
              <div className="cc-scene-row-meta"><label><input type="checkbox" checked={selectedTimes.has(scene.timeMs)} disabled={!!applied || !identityMatches}
                aria-label={t('选择切点 {n}', { n: index + 1 })} onChange={(event) => { const checked = event.target.checked; setSelectedTimes((previous) => {
                  const next = new Set(previous); checked ? next.add(scene.timeMs) : next.delete(scene.timeMs); return next;
                }); }} /><strong>#{index + 1}</strong></label><span>{formatTime(scene.timelineFrame / state.fps * 1000)}</span>
                <button type="button" className="cc-scene-preview" disabled={!onPreviewCut || !!applied || !identityMatches} onClick={() => preview(scene.timeMs)}>{t('查看画面')}</button>
                <details><summary>{t('检测信息')}</summary><small>{scene.kind === 'cut' ? t('硬切') : t('渐变')} · {scene.score.toFixed(3)}</small></details></div>
              <div className="cc-scene-evidence"><figure><img src={images.beforeThumbnailUrl} alt={t('切点前画面')} loading="lazy" /><figcaption>{t('之前')}</figcaption></figure>
                <i><Icon name="next" size={16} /></i><figure><img src={images.afterThumbnailUrl} alt={t('切点后画面')} loading="lazy" /><figcaption>{t('之后')}</figcaption></figure></div>
            </article>; })}</div>
        </main>
      </div>
      <footer className="cc-scene-footer"><span role="status">{applied === 'markers' ? t('已添加场景标记') : applied === 'split' ? t('已分割镜头，可一次撤销') : t('关联的原声音轨会同步分割，独立配乐和字幕保持原样。')}</span>
        <div><button type="button" className="cc-scene-button secondary" disabled={!canApply} onClick={() => apply('markers')}>{t('添加标记')}</button>
          <button type="button" className="cc-scene-button primary" disabled={!canApply} onClick={() => apply('split')}>{t('分成 {n} 个镜头', { n: chosen.length ? chosen.length + 1 : 0 })}</button></div></footer>
    </section></div>, document.body);
}
