import type { IconName } from '../icons';

export type ChatPanelActionKind = 'prompt' | 'open-paste-transcript';

interface ProjectStarter {
  readonly label: string;
  readonly description: string;
  readonly prompt: string;
  readonly icon: IconName;
  readonly action: ChatPanelActionKind;
}

interface QuickAction {
  readonly label: string;
  readonly prompt: string;
  readonly action: ChatPanelActionKind;
}

export const EMPTY_PROJECT_STARTERS: readonly ProjectStarter[] = [
  { label: '简单剪辑', description: '剪掉停顿并整理当前口播', prompt: '只对当前工程做简单剪辑：剪掉明显停顿和赘词，保持原有素材与结构', icon: 'scissors', action: 'prompt' },
  { label: '添加背景音乐', description: '为当前工程配一段低音量 BGM', prompt: '只为当前工程添加一段合适的低音量背景音乐，不改变画面和口播', icon: 'music', action: 'prompt' },
  { label: '粘贴文字稿生成字幕', description: '用文字稿和现有转写时间生成字幕', prompt: '请让我粘贴文字稿，再用当前工程已有的语音转写时间生成可编辑字幕', icon: 'captions', action: 'open-paste-transcript' },
];

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { label: '简单剪辑', prompt: '只对当前工程做简单剪辑：剪掉明显停顿和赘词，保持原有素材与结构', action: 'prompt' },
  { label: '添加背景音乐', prompt: '只为当前工程添加一段合适的低音量背景音乐，不改变画面和口播', action: 'prompt' },
  { label: '粘贴文字稿生成字幕', prompt: '请让我粘贴文字稿，再用当前工程已有的语音转写时间生成可编辑字幕', action: 'open-paste-transcript' },
];

