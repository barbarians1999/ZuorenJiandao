export const DESKTOP_CLOSE_BEHAVIOR_KEY = 'DESKTOP_CLOSE_BEHAVIOR';
export const DESKTOP_CLOSE_BEHAVIORS = ['ask', 'quit', 'background'] as const;
export type DesktopCloseBehavior = typeof DESKTOP_CLOSE_BEHAVIORS[number];

export function isDesktopCloseBehavior(value: unknown): value is DesktopCloseBehavior {
  return DESKTOP_CLOSE_BEHAVIORS.some((behavior) => behavior === value);
}
