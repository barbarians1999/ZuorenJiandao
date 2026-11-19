import { useCallback, useEffect, useRef, useState } from 'react';
import { TranscriptionError, transcribePath, type TranscribeOptions } from './provider';
import type { TranscriptResult, TranscriptStatus } from './types';
import { t } from '../i18n/locale';
import { checkLocalModelReadiness, localModelReadinessMessage, type LocalModelReadiness } from './localModelReadiness';
import { isTranscriptionCancelled, throwIfTranscriptionCancelled } from './transcriptionCancellation';

function transcriptErrorMessage(error: unknown): string {
  if (error instanceof TranscriptionError) {
    if (error.code === 'source-unavailable') return t('素材文件不可用，请在“我的素材”中重新链接后再转写');
    if (error.detail) return t('本地转写失败：{detail}', { detail: error.detail });
    return t('本地转写失败：模型未就绪或音频无法处理，请检查模型下载后重试');
  }
  return error instanceof Error ? error.message : String(error);
}

// One UI attempt owns its cancellation token. Late progress and results never
// update a replaced attempt, and unmount cancels only this hook's work.
export function useTranscript() {
  const [status, setStatus] = useState<TranscriptStatus>('idle');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<string | null>(null);
  const [modelReadiness, setModelReadiness] = useState<LocalModelReadiness | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const modelCheckSerial = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current?.abort(); attempt.current = null; };
  }, []);

  const cancel = useCallback(() => {
    attempt.current?.abort();
    attempt.current = null;
    if (!mounted.current) return;
    setStatus('idle'); setActiveItemId(null); setError(null);
    setProgressNote(t('已取消；已完成的文字稿保留，未完成的结果不会应用。'));
  }, []);

  const reset = useCallback(() => {
    attempt.current?.abort(); attempt.current = null;
    setStatus('idle'); setResult(null); setError(null); setActiveItemId(null); setProgressNote(null);
  }, []);

  const checkModel = useCallback(async (signal?: AbortSignal) => {
    const serial = ++modelCheckSerial.current;
    const readiness = await checkLocalModelReadiness(signal);
    if (mounted.current && !signal?.aborted && serial === modelCheckSerial.current) setModelReadiness(readiness);
    return readiness;
  }, []);

  /** Sequential jobs preserve already-completed clips, but stop immediately on cancellation. */
  const runMany = useCallback(async (
    jobs: { path: string; itemId: string; label: string }[],
    onEach: (itemId: string, r: TranscriptResult) => void,
    opts?: TranscribeOptions,
  ) => {
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    const alive = () => mounted.current && attempt.current === controller && !controller.signal.aborted;
    const externalCancel = () => controller.abort();
    opts?.signal?.addEventListener('abort', externalCancel, { once: true });
    if (opts?.signal?.aborted) controller.abort();
    setError(null); setResult(null); setStatus('uploading');
    setProgressNote(t('正在检查本机识别模型…'));
    let last: TranscriptResult | null = null;
    const failures: string[] = [];
    let ok = 0;
    try {
      const readiness = await checkModel(controller.signal);
      throwIfTranscriptionCancelled(controller.signal);
      if (readiness.state !== 'ready') throw new Error(localModelReadinessMessage(readiness));
      for (let i = 0; i < jobs.length; i++) {
        throwIfTranscriptionCancelled(controller.signal);
        const job = jobs[i]!;
        if (!alive()) break;
        setActiveItemId(job.itemId); setStatus('uploading');
        setProgressNote(t('({i}/{total}) 准备 {label}…', { i: i + 1, total: jobs.length, label: job.label }));
        try {
          const r = await transcribePath(job.path, (note) => {
            if (!alive()) return;
            setStatus('processing');
            setProgressNote(note
              ? t('({i}/{total}) {note}', { i: i + 1, total: jobs.length, note })
              : t('({i}/{total}) 识别 {label}…', { i: i + 1, total: jobs.length, label: job.label }));
          }, { ...opts, signal: controller.signal });
          throwIfTranscriptionCancelled(controller.signal);
          if (!alive()) break;
          last = r; setResult(r); onEach(job.itemId, r); ok += 1;
        } catch (cause) {
          if (isTranscriptionCancelled(cause) || controller.signal.aborted) throw cause;
          failures.push(`${job.label}: ${transcriptErrorMessage(cause)}`);
        }
      }
      if (!alive()) return last;
      if (failures.length && !ok) throw new Error(failures.join('；'));
      setStatus('done');
      setError(failures.length ? t('已完成 {ok}/{total} 段；失败：{fails}', { ok, total: jobs.length, fails: failures.join('；') }) : null);
      return last;
    } catch (cause) {
      if (mounted.current && attempt.current === controller && (controller.signal.aborted || isTranscriptionCancelled(cause))) {
        setStatus('idle'); setError(null);
      }
      if (alive()) {
        setError(transcriptErrorMessage(cause)); setStatus('error');
      }
      throw cause;
    } finally {
      opts?.signal?.removeEventListener('abort', externalCancel);
      if (attempt.current === controller) {
        attempt.current = null;
        if (mounted.current) { setActiveItemId(null); setProgressNote(null); }
      }
      // Release this attempt's browser model after success as well as failure.
      controller.abort();
    }
  }, [checkModel]);

  const run = useCallback(async (path: string, opts?: TranscribeOptions & { itemId?: string; label?: string }) => {
    const response = await runMany([{ path, itemId: opts?.itemId ?? '', label: opts?.label ?? t('音频') }], () => {}, opts);
    if (!response) throw new Error(t('未获得识别结果'));
    return response;
  }, [runMany]);

  return { status, result, error, activeItemId, progressNote, modelReadiness, checkModel, run, runMany, reset, cancel };
}
