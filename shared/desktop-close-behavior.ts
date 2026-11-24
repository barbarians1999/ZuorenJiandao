export const DESKTOP_CLOSE_BEHAVIOR_KEY = 'DESKTOP_CLOSE_BEHAVIOR';
export const DESKTOP_CLOSE_BEHAVIORS = ['ask', 'quit', 'background'] as const;
export type DesktopCloseBehavior = typeof DESKTOP_CLOSE_BEHAVIORS[number];

export function isDesktopCloseBehavior(value: unknown): value is DesktopCloseBehavior {
  return DESKTOP_CLOSE_BEHAVIORS.some((behavior) => behavior === value);
}

export const DESKTOP_CLOSE_CONFIRM_CHANNELS = {
  prompt: 'openchatcut:window-close-prompt',
  respond: 'openchatcut:window-close-respond',
  ready: 'openchatcut:window-close-ready',
} as const;

export type DesktopClosePromptAction = 'quit' | 'background' | 'cancel';

export interface DesktopClosePromptRequest {
  readonly requestId: string;
}

export interface DesktopClosePromptResponse {
  readonly requestId: string;
  readonly action: DesktopClosePromptAction;
  readonly remember: boolean;
}

function isPromptRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function isDesktopClosePromptRequest(value: unknown): value is DesktopClosePromptRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && isPromptRequestId(record.requestId);
}

export function isDesktopClosePromptResponse(value: unknown): value is DesktopClosePromptResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3
    && isPromptRequestId(record.requestId)
    && (record.action === 'quit' || record.action === 'background' || record.action === 'cancel')
    && typeof record.remember === 'boolean';
}
