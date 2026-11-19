export type ProjectQuickStart = 'edit' | 'captions';

export const PROJECT_QUICK_STARTS = [
  { intent: 'edit', title: '简单剪辑', description: '导入素材，分割和裁切片段', icon: 'scissors' },
  { intent: 'captions', title: '粘贴文字稿生成字幕', description: '导入口播并转写，再按文字稿对齐', icon: 'captions' },
] as const;

export function projectEditorHash(id: string, quickStart?: ProjectQuickStart): string {
  return `#/editor/${encodeURIComponent(id)}${quickStart ? `?start=${quickStart}` : ''}`;
}

export function editorRouteFromHash(hash: string): { id: string; quickStart?: ProjectQuickStart } | null {
  const match = /^#\/editor\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!match) return null;
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { return null; }
  const start = new URLSearchParams(match[2] ?? '').get('start');
  return {
    id,
    ...(start === 'edit' || start === 'captions' ? { quickStart: start } : {}),
  };
}
