// Hidden, owned Electron fixture host. Uses the real product preload/font IPC.
import { app, BrowserWindow, dialog } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { installDesktopFontsIpc } from '../desktop/font-library-ipc.ts';

const url = process.env.CC_WORKFLOW_FIXTURE_URL;
const profile = process.env.OPENCHATCUT_DATA_DIR;
if (!url || !profile || !process.env.OPENCHATCUT_DEV_PROFILE_ID) throw new Error('An isolated fixture origin/profile is required');
const origin = new URL(url).origin;
if (new URL(url).hostname !== '127.0.0.1') throw new Error('Fixture must remain on loopback');
const userData = join(profile, 'electron-ui'); mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
// Only the native file chooser is deterministic; parsing/persisting/rendering
// the real selected TTC bytes still runs through the production font bridge.
if (process.env.CC_WORKFLOW_FONT_PICK) dialog.showOpenDialog = (async () => ({ canceled: false,
  filePaths: [resolve(process.env.CC_WORKFLOW_FONT_PICK!)] })) as typeof dialog.showOpenDialog;
// Electron waits for ESM entry evaluation before emitting ready. Awaiting ready
// at the top level would deadlock the fixture before CDP even starts.
app.whenReady().then(async () => {
installDesktopFontsIpc(origin);
const win = new BrowserWindow({ show: false, width: 1460, height: 1060, webPreferences: {
  preload: resolve('desktop-dist/preload.cjs'), contextIsolation: true, nodeIntegration: false,
  backgroundThrottling: false, spellcheck: false, offscreen: true,
} });
win.webContents.setFrameRate(30);
win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
await win.loadURL(url);
writeFileSync(join(profile, 'electron-ui-identity.json'), JSON.stringify({ pid: process.pid,
  startedAt: new Date().toISOString(), origin, userData, visible: false, nativeFontBridge: true }, null, 2));
console.log(`HIDDEN-ELECTRON-READY pid=${process.pid}`);
setTimeout(() => app.quit(), 20 * 60_000).unref();
app.on('window-all-closed', () => app.quit());
}).catch((error) => { console.error(error); app.exit(1); });
