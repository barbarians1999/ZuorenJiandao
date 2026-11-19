import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { prebuildServeBundle, renderTimelineStills, setUploadsDirProvider } from '../remotion/render.mjs';
import { auditSharedVisual } from './long-video-audit.mts';

const root = await mkdtemp(join(tmpdir(), 'zuoren-shared-visual-render-'));
const source = join(root, 'source.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true });
const stagedBrowser = resolve('desktop-dist/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe');
if (!process.env.CC_BROWSER_EXECUTABLE && existsSync(stagedBrowser)) process.env.CC_BROWSER_EXECUTABLE = stagedBrowser;
process.env.CC_REMOTION_BUNDLE = await prebuildServeBundle(join(root, 'serve'));
setUploadsDirProvider(() => root);
const results = await auditSharedVisual(root, '/media/uploads/source.mp4', renderTimelineStills);
await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
console.log(`shared-visual actual render comparison passed; images/results: ${root}`);
