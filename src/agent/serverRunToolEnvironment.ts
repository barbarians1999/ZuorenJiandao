/** Add concrete recovery steps only for execution-environment failures. */
export function environmentFailureHint(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!/unavailable|not connected|app-server|cannot call|no editor|bridge|environment|execution/i.test(base)) {
    return base;
  }
  return `${base} 若为工具执行环境故障，请确认：工程已打开、Codex 已登录（设置 → Codex）、应用服务正常运行。`;
}