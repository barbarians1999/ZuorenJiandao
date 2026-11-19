// Keep server-generated interface messages in Chinese, including after an older install used another locale.
let lastSent: string | null = null;

async function sendChineseUiLocale(): Promise<void> {
  if (lastSent === 'zh' || typeof fetch !== 'function') return;
  lastSent = 'zh';
  try {
    await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UI_LOCALE: 'zh' }),
    });
  } catch {
    lastSent = null;
  }
}

export function startUiLocaleSync(stored?: string): () => void {
  if (stored === 'zh') lastSent = 'zh';
  void sendChineseUiLocale();
  return () => {};
}