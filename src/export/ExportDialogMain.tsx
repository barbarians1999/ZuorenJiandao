import { useEffect, useMemo, useState } from 'react';
import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { formatDeclineReason, formatExportDiagnostics } from './exportDiagnostics';
import { analyzeExportRoutePreflight, type ExportRoutePreflight } from './exportPreflight';
import { ExportDestinationBar } from './ExportDestinationBar';
import { ExportFooter, formatProgressPercent } from './ExportDialogFooter';
import { ExportTabContent } from './ExportDialogTabs';
import { EXPORT_TABS, type ExportDialogModel } from './useExportDialogModel';
import type { ExportTab, RenderEngine } from './useExportWorkflow';
import type { ExportEngineInfo } from './exportWorkflowTypes';
import type { ExportPhase } from './exportWorkflowTypes';

const BACKGROUND_PHASE_LABELS: Record<ExportPhase, string> = {
  queued: '等待中',
  preparing: '准备中',
  rendering: '正在生成画面',
  finalizing: '正在封装',
  verifying: '正在质量检查',
  downloading: '正在保存',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function RenderBadge({ tab, renderEngine, engine, reason }: {
  tab: ExportTab;
  renderEngine: RenderEngine;
  engine: ExportEngineInfo | null;
  reason: string | null;
}) {
  const t = useT();
  const label = tab !== 'video' ? t('本机渲染')
    : engine ? t(engine.label)
      : renderEngine === 'checking' ? t('正在检测本机') : t('本机自适应');
  const accelerated = tab !== 'video' || engine?.hardware;
  return <span className={`cc-export-local-badge${accelerated ? ' accelerated' : ''}`} title={reason ? t(reason) : undefined}><i />{label}</span>;
}

function ExportMainHeader({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const activeTab = EXPORT_TABS.find((entry) => entry.key === model.tab) ?? EXPORT_TABS[0];
  return (
    <div className="cc-export-main-header">
      <div><h3>{t(activeTab.label)}</h3><p>{activeTab.summary}</p></div>
      <RenderBadge tab={model.tab} renderEngine={model.workflow.renderEngine}
        engine={model.workflow.engineInfo} reason={model.workflow.engineReason} />
    </div>
  );
}

function BackgroundExportJobs({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const { jobs, selectedJobId, viewJob, cancelJob, clearTerminal } = model.workflow;
  const progress = model.workflow.progress;
  const footerCanCancel = !!model.workflow.busy
    && (progress?.phase === 'queued' || progress?.phase === 'preparing' || progress?.phase === 'rendering'
      || progress?.phase === 'finalizing' || progress?.phase === 'verifying')
    && (model.workflow.renderEngine === 'checking' || model.workflow.renderEngine === 'browser'
      || model.workflow.renderEngine === 'server');
  if (jobs.length === 0) return null;
  const terminalCount = jobs.filter((job) => ['completed', 'failed', 'cancelled'].includes(job.progress.phase)).length;
  return (
    <section className="cc-export-progress" aria-label={t('后台导出任务')}>
      <div className="cc-export-progress-head">
        <div className="cc-export-progress-title">
          <strong>{t('后台导出')}</strong>
          <span>{jobs.length}</span>
        </div>
        {terminalCount > 0 && (
          <button type="button" className="cc-export-clear-terminal" onClick={clearTerminal}>
            {t('清除已结束')}
          </button>
        )}
      </div>
      {jobs.map((job) => {
        const terminal = job.progress.phase === 'completed'
          || job.progress.phase === 'failed'
          || job.progress.phase === 'cancelled';
        return (
          <div className="cc-export-progress-meta" key={job.id}>
            <button type="button" onClick={() => viewJob(job.id)}
              aria-pressed={selectedJobId === job.id}>
              {job.label} · {t(BACKGROUND_PHASE_LABELS[job.progress.phase])} · {formatProgressPercent(job.progress)}
            </button>
            {!terminal && !(job.id === selectedJobId && footerCanCancel) && (
              <button type="button" onClick={() => cancelJob(job.id)}>{t('取消')}</button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function StructuredExportFailure({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const failure = model.workflow.failure;
  if (!failure) return model.workflow.error
    ? <p className="cc-export-error">{model.workflow.error}</p>
    : null;
  return (
    <div className="cc-export-error" role="alert">
      <strong>{failure.message}</strong>
      <p>{failure.retryable ? t('可以重试导出；若再次失败，请展开技术详情。') : t('请根据提示检查素材或设置后再次导出。')}</p>
      <details><summary>{t('技术详情')}</summary>
      <div>{failure.stage} · {failure.code}</div>
      <div>{t('临时文件清理')}：{failure.cleanupStatus}</div>
      </details>
      {failure.targetPath && <div>{failure.targetPath}</div>}
      {failure.mediaIssues?.length ? (
        <ul>
          {failure.mediaIssues.map((issue, index) => (
            <li key={`${issue.code}-${issue.itemId ?? issue.source ?? index}`}>
              {issue.itemId ? `${issue.itemId}: ` : ''}{issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function formatCompatClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${pad(mins)}:${pad(secs)}`;
}

function ExportRoutePreflightNotice({ state, model }: { state: TimelineState; model: ExportDialogModel }) {
  const t = useT();
  const frameRange = model.startFrame !== undefined && model.endFrameExclusive !== undefined
    ? [model.startFrame, Math.max(model.startFrame, model.endFrameExclusive - 1)] as [number, number]
    : undefined;
  const localPreflight = useMemo(
    () => (model.tab === 'video' ? analyzeExportRoutePreflight(state, model.video.codec, model.video.fps, frameRange) : null),
    [state, model.tab, model.video.codec, model.video.fps, frameRange?.[0], frameRange?.[1]],
  );
  const [probedState, setProbedState] = useState<{ key: string; preflight: ExportRoutePreflight } | null>(null);
  const queryKey = model.tab === 'video'
    ? `${model.video.codec}:${model.video.resolution}:${model.video.fps}:${model.startFrame ?? ''}:${model.endFrameExclusive ?? ''}`
    : '';

  useEffect(() => {
    if (model.tab !== 'video' || typeof fetch !== 'function') return undefined;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(async () => {
      try {
        const response = await fetch('/export/capabilities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state,
            ...(model.project && model.timelineId ? { project: model.project, timelineId: model.timelineId } : {}),
            format: 'video',
            codec: model.video.codec,
            resolution: model.video.resolution,
            fps: model.video.fps,
            ...(model.startFrame !== undefined ? { startFrame: model.startFrame } : {}),
            ...(model.endFrameExclusive !== undefined ? { endFrameExclusive: model.endFrameExclusive } : {}),
            videoBitrate: model.video.requestedBitrate,
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok || controller.signal.aborted) return;
        const payload = await response.json() as { preflight?: ExportRoutePreflight };
        if (payload.preflight && !controller.signal.aborted) {
          setProbedState({ key: queryKey, preflight: payload.preflight });
        }
      } catch {
        // Ignore abort / offline unit renders and fall back to shared planner summary.
      }
    }, 60);
    return () => {
      controller.abort();
      globalThis.clearTimeout(timer);
    };
  }, [
    state,
    model.project,
    model.timelineId,
    model.tab,
    model.video.codec,
    model.video.resolution,
    model.video.fps,
    model.video.requestedBitrate,
    model.startFrame,
    model.endFrameExclusive,
    queryKey,
  ]);

  if (!localPreflight || model.workflow.progress?.phase === 'completed') return null;
  const matchedProbed = probedState?.key === queryKey ? probedState.preflight : null;
  const preflight = matchedProbed ?? localPreflight;
  const checkingServer = !matchedProbed && model.tab === 'video' && model.video.codec === 'h264';
  const reasonText = preflight.reasons.map((r) => formatDeclineReason(r, t)).filter(Boolean).join('、');
  const message = checkingServer
    ? t('导出预检：正在核对素材与导出计划（待检查）…')
    : preflight.mode === 'fast'
      ? t('导出预检：将走极速硬件导出（常规剪辑与静态效果全速合成）')
      : preflight.mode === 'segmented'
        ? t('导出预检：将走分段混合导出（绝大部分极速硬编，仅约 {sec} 秒走精细渲染{reasons}）', {
          sec: preflight.compatSeconds,
          reasons: reasonText ? `：${reasonText}` : '',
        })
        : t('导出预检：将走完整逐帧渲染{reasons}', { reasons: reasonText ? `（${reasonText}）` : '' });
  const visibleSpans = preflight.spanDetails.slice(0, 12);
  const extraSpans = preflight.spanDetails.length - visibleSpans.length;
  return (
    <div className="cc-export-footnote" role="status">
      <div>{message}</div>
      {!checkingServer && preflight.probeStatus === 'pending-media' && (
        <div>{t('提示：部分素材信息待落盘确认，开始导出前将自动核实实际参数。')}</div>
      )}
      {preflight.mode !== 'fast' && visibleSpans.length > 0 && (
        <details>
          <summary>{t('查看精细渲染片段明细（{n} 处）', { n: preflight.spanDetails.length })}</summary>
          <ul>
            {visibleSpans.map((sp) => {
              const spanReasons = sp.reasons.map((r) => formatDeclineReason(r, t)).filter(Boolean).join('、');
              const names = sp.itemNames.length ? `${sp.itemNames.join('、')} · ` : '';
              return (
                <li key={`${sp.fromFrame}-${sp.toFrame}`}>
                  {formatCompatClock(sp.fromSeconds)}–{formatCompatClock(sp.toSeconds)} · {names}{spanReasons}
                </li>
              );
            })}
            {extraSpans > 0 && <li>{t('…另有 {n} 处', { n: extraSpans })}</li>}
          </ul>
        </details>
      )}
      {preflight.animatedCaptionWarning && (
        <div>{t('提示：当前开启了逐字动态字幕，较长视频需要绘制较多文字透明层，导出时间会适当增加。')}</div>
      )}
    </div>
  );
}

function ExportDiagnosticsSummary({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const formatted = model.workflow.progress?.phase === 'completed'
    ? formatExportDiagnostics(model.workflow.diagnostics, model.workflow.engineInfo, t)
    : null;
  if (!formatted) return null;
  return (
    <div className="cc-export-footnote" role="status">
      <div>{formatted.summary}</div>
      {formatted.details.length > 0 && (
        <details>
          <summary>{t('耗时明细')}</summary>
          <div>{formatted.details.join(' · ')}</div>
        </details>
      )}
    </div>
  );
}

export function ExportDialogMain({ state, model }: { state: TimelineState; model: ExportDialogModel }) {
  const { workflow } = model;
  const t = useT();
  const settingsLocked = !!workflow.busy || workflow.progress?.phase === 'completed';
  const settingsLockMessage = workflow.busy
    ? t('导出中，参数已锁定')
    : t('本次导出已完成');
  return (
    <main className="cc-export-main">
      <ExportMainHeader model={model} />
      <div className="cc-export-content" role="tabpanel" id={`cc-export-content-${model.tab}`}
        aria-labelledby={`cc-export-tab-${model.tab}`}>
        {settingsLocked && <p className="cc-export-footnote">{settingsLockMessage}</p>}
        <fieldset className="cc-export-settings" aria-label={t('导出设置')} disabled={settingsLocked}>
          <ExportTabContent
            tab={model.tab} state={state} video={model.video} subtitles={model.subtitles}
            busy={!!workflow.busy} enabled={workflow.autoQaEnabled} qa={workflow.qa}
            qualityMode={model.qualityMode} setQualityMode={model.setQualityMode}
            onToggle={workflow.toggleAutoQa} nleFormat={model.nleFormat}
            setNleFormat={model.setNleFormat} includeMg={model.includeMg}
            setIncludeMg={model.setIncludeMg} mgCount={model.mgItems.length} base={model.base}
          />
        </fieldset>
        <ExportRoutePreflightNotice state={state} model={model} />
        <ExportDiagnosticsSummary model={model} />
        <StructuredExportFailure model={model} />
      </div>
      <BackgroundExportJobs model={model} />
      {model.tab !== 'jianying' && (
        <ExportDestinationBar busy={!!workflow.busy} choosing={workflow.choosingDestination}
          destination={workflow.destination} onChoose={workflow.chooseDestination} />
      )}
      <ExportFooter tab={model.tab} outputName={model.outputName} videoSummary={model.videoSummary}
        disabled={model.disabled} workflow={workflow} />
    </main>
  );
}
