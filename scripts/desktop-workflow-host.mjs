// Launch the real production desktop entry with a persistent isolated profile.
// This host controls only profile, diagnostics, CDP, and an optional save chooser.
import { app, dialog } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.CC_WORKFLOW_ROOT;
if (!root || !isAbsolute(root)) throw new Error('CC_WORKFLOW_ROOT must be an absolute path');
if (process.env.CC_SMOKE === '1') throw new Error('Workflow host must not run with CC_SMOKE=1');
if (process.env.CC_DESKTOP_DEV_URL) throw new Error('Unset CC_DESKTOP_DEV_URL to use the production desktop');
const port = Number(process.env.CC_WORKFLOW_CDP);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('CC_WORKFLOW_CDP must be a dedicated port from 1024 to 65535');
}
const exportFile = process.env.CC_WORKFLOW_EXPORT_FILE;
if (exportFile && !isAbsolute(exportFile)) throw new Error('CC_WORKFLOW_EXPORT_FILE must be absolute');
for (const required of ['desktop-dist/main.mjs', 'desktop-dist/app-main.mjs', 'desktop-dist/preload.cjs', 'dist/index.html']) {
  if (!existsSync(join(workspace, required))) throw new Error(`Missing production build: ${required}`);
}
mkdirSync(root, { recursive: true });
const logPath = join(root, 'desktop-workflow.jsonl');
function record(event, details = {}) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`);
}
const profileFile = join(root, 'workflow-profile.json');
const profileId = existsSync(profileFile)
  ? JSON.parse(readFileSync(profileFile, 'utf8')).profileId
  : randomUUID();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profileId)) {
  throw new Error('Invalid persisted workflow profile ID');
}
if (!existsSync(profileFile)) writeFileSync(profileFile, `${JSON.stringify({ profileId }, null, 2)}\n`, { flag: 'wx' });
const dataDir = join(root, 'data');
const userData = join(dataDir, 'electron-user-data');
mkdirSync(userData, { recursive: true });
process.env.OPENCHATCUT_DEV_PROFILE_ID = profileId;
process.env.OPENCHATCUT_DATA_DIR = dataDir;
process.chdir(workspace);
app.setPath('userData', userData);
app.commandLine.appendSwitch('remote-debugging-port', String(port));
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
const identity = {
  pid: process.pid, parentPid: process.ppid, startedAt: new Date().toISOString(),
  workspace, root, profileId, dataDir, userData, cdpPort: port,
  executable: process.execPath, argv: process.argv, electron: process.versions.electron,
  saveChooserControlled: Boolean(exportFile), exportFile: exportFile ?? null,
};
writeFileSync(join(root, 'desktop-workflow-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
record('launch', identity);
for (const level of ['log', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    record('console', { level, message: args.map((arg) => arg instanceof Error ? arg.stack : String(arg)).join(' ') });
    original(...args);
  };
}
process.on('uncaughtExceptionMonitor', (error) => record('uncaught-exception', { error: error.stack ?? String(error) }));
process.on('unhandledRejection', (error) => {
  record('unhandled-rejection', { error: error instanceof Error ? error.stack : String(error) });
  console.error('[workflow-host] unhandled rejection', error);
  app.exit(1);
});
app.on('child-process-gone', (_event, details) => record('child-process-gone', details));
app.on('render-process-gone', (_event, contents, details) => record('render-process-gone', { id: contents.id, ...details }));
app.on('browser-window-created', (_event, win) => {
  const id = win.id;
  record('window-created', { id });
  if (process.env.CC_WORKFLOW_HIDE === '1') {
    win.hide();
    win.on('show', () => win.hide());
  }
  win.webContents.on('did-finish-load', () => record('page-loaded', { id, url: win.webContents.getURL() }));
  win.webContents.on('did-fail-load', (_event, code, description, url) => record('page-load-failed', { id, code, description, url }));
  win.on('closed', () => record('window-closed', { id }));
});
app.on('before-quit', () => record('before-quit'));
app.on('quit', (_event, exitCode) => record('quit', { exitCode }));
if (exportFile) {
  dialog.showSaveDialog = async (...args) => {
    const options = args.at(-1);
    record('chooser-controlled', {
      method: 'dialog.showSaveDialog', title: options?.title,
      suggestedPath: options?.defaultPath, chosenPath: exportFile,
      nativePickerExercised: false,
    });
    return { canceled: false, filePath: exportFile };
  };
}
try {
  await import(pathToFileURL(join(workspace, 'desktop-dist/main.mjs')).href);
  record('production-entry-loaded');
} catch (error) {
  record('startup-failed', { error: error instanceof Error ? error.stack : String(error) });
  console.error('[workflow-host] production entry failed', error);
  app.exit(1);
}
