// Run a packaged Windows app outside the checkout so ancestor node_modules
// cannot hide a missing shipped dependency. Test data never uses real profiles.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackagedProductAssets, verifyPackagedRuntimeDependencies } from '../desktop/packaged-runtime-dependencies.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/verify-packaged-isolated.mjs path/to/ZuorenJiandao.exe');
const executable = realpathSync(resolve(process.argv[2]));
const appRoot = dirname(executable);
const fromProject = relative(realpathSync(projectRoot), appRoot);
if (!fromProject || (!isAbsolute(fromProject) && !fromProject.startsWith(`..${sep}`) && fromProject !== '..')) {
  throw new Error('Refusing a smoke test inside the checkout: use an independent unpacked/extracted package');
}
verifyPackagedRuntimeDependencies(join(appRoot, 'resources', 'app.asar'));
verifyPackagedProductAssets(join(appRoot, 'resources'));
// Keep test profiles outside appRoot: a later NSIS archive must not include them.
const restartProfile = process.argv.find((arg) => arg.startsWith('--restart-profile='))?.slice('--restart-profile='.length);
const profile = restartProfile ? realpathSync(resolve(restartProfile)) : join(dirname(appRoot), `isolated-smoke-${Date.now()}`);
if (restartProfile && (dirname(profile) !== dirname(appRoot) || !/^isolated-smoke-\d+$/.test(profile.split(sep).at(-1)))) {
  throw new Error('Restart continuation must reuse the existing sibling smoke profile');
}
mkdirSync(profile, { recursive: true });
const profileId = randomUUID();
const runStamp = Date.now();
writeFileSync(join(profile, `smoke-identity-${runStamp}.json`), JSON.stringify({ executable, profile, profileId, restartOnly: !!restartProfile, startedAt: new Date().toISOString() }, null, 2));
async function runSmoke(phase, render) {
const child = spawn(executable, [], {
  cwd: appRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, NODE_PATH: '', NODE_OPTIONS: '',
    // Chromium inherits this into its render children; keep diagnostics out of
    // app resources so smoke validation cannot alter the distributable bytes.
    CHROME_LOG_FILE: join(profile, `chrome-${phase}-${runStamp}.log`),
    CC_SMOKE: '1', CC_SMOKE_EDITOR_ONLY: '1', CC_SMOKE_RENDER: render ? '1' : '0',
    CC_SMOKE_FAST_EXPORT: render ? '1' : '0',
    CC_SMOKE_MASK_BLUR: render && process.env.CC_VERIFY_MASK_BLUR === '1' ? '1' : '0',
    CC_SMOKE_MCP_RECOVERY: '0', CC_SMOKE_RENDERER_RECOVERY: '0',
    CC_SMOKE_PREVIEW_PHASE: phase,
    CC_SMOKE_USER_DATA_DIR: join(profile, 'electron'),
    OPENCHATCUT_DATA_DIR: join(profile, 'data'),
    OPENCHATCUT_DEV_PROFILE_ID: profileId,
  },
});
let stdout = '', stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
const watchdog = setTimeout(() => {
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else child.kill();
}, 300_000);
try {
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
  const stem = restartProfile ? `restart-continuation-${runStamp}` : phase === 'write' ? '' : 'restart-';
  writeFileSync(join(profile, `${stem}${restartProfile ? '-' : ''}stdout.log`), stdout);
  writeFileSync(join(profile, `${stem}${restartProfile ? '-' : ''}stderr.log`), stderr);
  if (code !== 0 || !/^SMOKE-OK\s*$/m.test(stdout)) {
    throw new Error(`Isolated package smoke failed (exit ${code}); logs: ${profile}`);
  }
  if (`${stdout}\n${stderr}`.includes('[desktop] UI scale rebase skipped:')) {
    throw new Error(`First-launch UI settings did not persist; logs: ${profile}`);
  }
  if (!stdout.includes(`[smoke] preview preference ${phase} ok`)) {
    throw new Error(`Preview persistence phase ${phase} did not run; logs: ${profile}`);
  }
  if (restartProfile) {
    const original = readFileSync(join(profile, 'stdout.log'), 'utf8');
    const origin = (text) => text.match(/\[desktop\] embedded server at (http:\/\/\S+)/)?.[1];
    if (!origin(original) || origin(stdout) !== origin(original)) throw new Error('Restart changed the saved preference origin');
  }
  if (render && (!stdout.includes('[smoke] packaged direct-cut export ok') || !stdout.includes('[smoke] packaged hybrid export ok'))) {
    throw new Error(`Packaged fast export routes did not run; logs: ${profile}`);
  }
  if (render && process.env.CC_VERIFY_MASK_BLUR === '1' && !stdout.includes('[smoke] packaged mask/gaussian export ok')) {
    throw new Error(`Packaged mask/Gaussian checks did not run; logs: ${profile}`);
  }
  console.log(`[isolated-smoke] passed; logs: ${profile}`);
} finally {
  clearTimeout(watchdog);
}
}
if (!restartProfile) await runSmoke('write', true);
await runSmoke('read', false);
console.log(`[isolated-smoke] application restart retained preview setting; logs: ${profile}`);
