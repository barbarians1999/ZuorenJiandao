import { asrModelEntry } from '../../shared/asr-models';
import { chooseAsrConfig, detectDeviceProfile } from './deviceProfile';
import { cancellableTranscription, isTranscriptionCancelled, throwIfTranscriptionCancelled } from './transcriptionCancellation';

export interface LocalModelReadiness {
  state: 'ready' | 'missing' | 'unavailable';
  label: string;
}

/** UI preflight is deliberately fail-closed: never start audio preparation on an unknown catalog. */
export async function checkLocalModelReadiness(signal?: AbortSignal, timeoutMs = 10_000): Promise<LocalModelReadiness> {
  throwIfTranscriptionCancelled(signal);
  let label = '';
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const profile = await cancellableTranscription(() => detectDeviceProfile(), controller.signal);
    const config = chooseAsrConfig(profile);
    label = asrModelEntry(config.modelTier)?.label ?? config.modelTier;
    const response = await cancellableTranscription(() => fetch('/api/asr-models', { cache: 'no-store', signal: controller.signal }), controller.signal);
    if (!response.ok) return { state: 'unavailable', label };
    const body = await cancellableTranscription(() => response.json(), controller.signal) as { models?: Array<{ modelId?: string; downloaded?: boolean }> };
    throwIfTranscriptionCancelled(controller.signal);
    const entry = Array.isArray(body.models) ? body.models.find((model) => model?.modelId === config.modelId) : undefined;
    return { state: entry?.downloaded === true ? 'ready' : entry?.downloaded === false ? 'missing' : 'unavailable', label };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (!timedOut && isTranscriptionCancelled(error)) throw error;
    return { state: 'unavailable', label };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function localModelReadinessMessage(readiness: LocalModelReadiness): string {
  if (readiness.state === 'ready') return `本机识别模型已就绪（${readiness.label}）`;
  if (readiness.state === 'missing') return `本机识别模型尚未完整下载（${readiness.label}）。请先在设置中下载模型，再重新检查。`;
  return '暂时无法确认本机识别模型。请检查设置中的模型状态，再重新检查。';
}
