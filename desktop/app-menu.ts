import type { Menu, MenuItemConstructorOptions } from 'electron';

export const NATIVE_EDIT_ACTIONS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const;
export type NativeEditAction = (typeof NATIVE_EDIT_ACTIONS)[number];

export function isNativeEditAction(value: unknown): value is NativeEditAction {
  return typeof value === 'string' && (NATIVE_EDIT_ACTIONS as readonly string[]).includes(value);
}

interface MacMenuWebContentsTarget {
  isDestroyed?: () => boolean;
  undo: () => void;
  redo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

interface MacMenuWindowTarget {
  webContents?: MacMenuWebContentsTarget;
  minimize?: () => void;
}

export interface BuildMacMenuOptions {
  appName: string;
  includeDevTools: boolean;
  onEditAction: (action: NativeEditAction, win?: MacMenuWindowTarget) => void;
}

/**
 * Build a macOS application menu that preserves system App/File/Window chrome
 * without registering Cocoa Edit/View/Minimize roles or accelerators that
 * intercept renderer keydown shortcuts (Cmd+Z/C/V/X/A, Cmd+=/- /0, Cmd+R, Cmd+M).
 */
export function buildMacApplicationMenuTemplate({
  appName,
  includeDevTools,
  onEditAction,
}: BuildMacMenuOptions): MenuItemConstructorOptions[] {
  const editItems: ReadonlyArray<{ label: string; action: NativeEditAction }> = [
    { label: '撤销', action: 'undo' },
    { label: '重做', action: 'redo' },
    { label: '剪切', action: 'cut' },
    { label: '复制', action: 'copy' },
    { label: '粘贴', action: 'paste' },
    { label: '全选', action: 'selectAll' },
  ];

  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'togglefullscreen', label: '进入全屏幕' },
    ...(includeDevTools ? [{ role: 'toggleDevTools' as const, label: '切换开发者工具' }] : []),
  ];

  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于${appName}` },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出${appName}` },
      ],
    },
    {
      label: '文件',
      submenu: [
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: editItems.map(({ label, action }) => ({
        label,
        click: (_item, win) => onEditAction(action, win as MacMenuWindowTarget | undefined),
      })),
    },
    {
      label: '视图',
      submenu: viewSubmenu,
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '最小化',
          click: (_item, win) => (win as MacMenuWindowTarget | undefined)?.minimize?.(),
        },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
  ];
}

export interface InstallDesktopApplicationMenuOptions {
  appName?: string;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  menuApi?: Pick<typeof Menu, 'buildFromTemplate' | 'setApplicationMenu'>;
  getFocusedWindow?: () => MacMenuWindowTarget | null | undefined;
}

export function installDesktopApplicationMenu(
  options: InstallDesktopApplicationMenuOptions = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return false;
  if (!options.menuApi) throw new Error('menuApi is required to install macOS application menu');
  const menuApi = options.menuApi;
  const getFocusedWindow = options.getFocusedWindow ?? (() => undefined);
  const appName = options.appName ?? '左人剪刀';
  const includeDevTools = !(options.isPackaged ?? false);

  const template = buildMacApplicationMenuTemplate({
    appName,
    includeDevTools,
    onEditAction: (action, win) => {
      const targetWin = win ?? getFocusedWindow() ?? undefined;
      const webContents = targetWin?.webContents;
      if (!webContents || webContents.isDestroyed?.()) return;
      webContents[action]();
    },
  });
  menuApi.setApplicationMenu(menuApi.buildFromTemplate(template));
  return true;
}
