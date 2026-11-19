import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { windowsPackagePlan, windowsUpdateMetadata, verifyWindowsPackage } from './package-windows.mjs';
import { assertDeliverySpace, copyDeliveryMetadata, planPackageCleanup } from './package-current.mjs';
import { isChromeRuntimeAsset } from '../desktop/prepare-target.mts';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';

const plan = windowsPackagePlan({ node: 'node.exe', electronDist: '' });
assert.equal(windowsPackagePlan({ node: 'node.exe', installedPnpm: true })[0].env.npm_config_user_agent, 'pnpm');
assert.equal(windowsPackagePlan({ node: 'node.exe', installedPnpm: false })[0].env.npm_config_user_agent, undefined);
assert.deepEqual(plan.map(({ kind }) => kind), ['nsis']);
for (const step of plan) {
  assert.equal(step.env.CC_EB_TARGET, 'win32-x64');
  assert.equal(step.env.CC_EB_WIN_KIND, step.kind);
  assert.deepEqual(step.args, [
    'node_modules/electron-builder/cli.js', '--config', 'config/electron-builder.config.mjs',
    '--win', '--x64', '--publish', 'never',
  ]);
}

const localElectron = 'C:\\verified-cache\\electron-v43.1.1-win32-x64.zip';
const offlinePlan = windowsPackagePlan({ node: 'node.exe', electronDist: localElectron });
for (const step of offlinePlan) {
  assert.ok(
    step.args.includes(`--config.electronDist=${localElectron}`),
    'a verified local Electron archive must bypass release-network downloads',
  );
}

const configSource = await readFile(new URL('../config/electron-builder.config.mjs', import.meta.url), 'utf8');
const workflowSource = await readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
assert.match(configSource, /appId:\s*'org\.zuoren\.jiandao'/);
assert.match(configSource, /productName:\s*isWindowsTarget \? '左人剪刀' : 'OpenChatCut'/);
assert.match(configSource, /icon:\s*'assets\/branding\/zuoren-jiandao-icon\.ico'/);
assert.match(configSource, /installerIcon:\s*'assets\/branding\/zuoren-jiandao-icon\.ico'/);
assert.match(configSource, /uninstallerIcon:\s*'assets\/branding\/zuoren-jiandao-icon\.ico'/);
assert.match(configSource, /installerHeaderIcon:\s*'assets\/branding\/zuoren-jiandao-icon\.ico'/);
const windowsIcon = await readFile(new URL('../assets/branding/zuoren-jiandao-icon.ico', import.meta.url));
assert.equal(windowsIcon.readUInt16LE(0), 0, 'ICO reserved field');
assert.equal(windowsIcon.readUInt16LE(2), 1, 'ICO resource type');
assert.equal(windowsIcon.readUInt16LE(4), 7, 'ICO must contain seven raster sizes');
assert.deepEqual(
  Array.from({ length: 7 }, (_, i) => windowsIcon[6 + i * 16] || 256),
  [16, 24, 32, 48, 64, 128, 256],
  'Windows icon must include crisp small-size and high-resolution frames',
);
assert.ok(windowsIcon.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'ICO frames must contain PNG images');
assert.match(configSource, /executableName:\s*'ZuorenJiandao'/);
assert.match(configSource, /directories:\s*\{\s*output:\s*process\.env\.CC_EB_OUTPUT\?\.trim\(\)\s*\|\|\s*'release'\s*\}/);
assert.match(configSource, /ZuorenJiandao-Setup-\$\{version\}-\$\{arch\}/);
assert.match(configSource, /target:\s*\['nsis'\]/);
assert.doesNotMatch(configSource, /ZuorenJiandao-Portable-/);
assert.match(configSource, /from: 'desktop-dist\/remotion-bundle', to: 'remotion-bundle', filter: \['\*\*\/\*', '!media\/uploads', '!media\/uploads\/\*\*'\]/, 'Runtime upload links and user media must never enter the packaged render bundle');
assert.doesNotMatch(configSource, /provider:\s*'github'/, 'internal packages must not carry upstream publish metadata');
assert.match(workflowSource, /-Filter 'ZuorenJiandao-Setup-\*\.exe'/);
assert.doesNotMatch(workflowSource, /ZuorenJiandao-Portable-/);
assert.match(workflowSource, /test -f release-files\/latest\.yml/);
assert.match(workflowSource, /test -f "release-files\/ZuorenJiandao-Setup-\$\{EXPECTED_VERSION\}-x64\.exe"/);
assert.match(workflowSource, /Join-Path \$installDir 'ZuorenJiandao\.exe'/);
assert.doesNotMatch(
  workflowSource,
  /Join-Path \$installDir 'OpenChatCut\.exe'/,
  'installed smoke must launch the executableName produced by the Windows builder config',
);

console.log('package-windows.verify: deterministic artifacts and installed-smoke contract OK');

const bytes = Buffer.from('installer fixture');
const deliveryFixture = await mkdtemp(join(tmpdir(), 'zuoren-delivery-evidence-'));
try {
  const source=join(deliveryFixture,'delivery'), evidence=join(deliveryFixture,'evidence');
  await mkdir(source);await mkdir(evidence);
  for(const [name,content] of [['setup.exe','installer'],['setup.exe.blockmap','blockmap'],['latest.yml','metadata']])
    await writeFile(join(source,name),content);
  await copyDeliveryMetadata(source,evidence,'setup.exe');
  assert.equal(await readFile(join(evidence,'latest.yml'),'utf8'),'metadata');
  assert.equal(await readFile(join(evidence,'setup.exe.blockmap'),'utf8'),'blockmap');
  await assert.rejects(stat(join(evidence,'setup.exe')),{code:'ENOENT'});
  assert.equal(await readFile(join(source,'setup.exe'),'utf8'),'installer');
  const reserve=8*1024**3, overhead=256*1024**2;
  assert.throws(()=>assertDeliverySpace(source,0,{available:reserve+overhead-1,env:{CC_TEST_MIN_FREE_BYTES:'0'}}),/Low artifact disk space/);
  assert.doesNotThrow(()=>assertDeliverySpace(source,0,{available:reserve+overhead,env:{CC_TEST_MIN_FREE_BYTES:'0'}}));
  const unpacked=join(source,'win-unpacked'), outside=join(deliveryFixture,'original-media');
  await mkdir(unpacked);await mkdir(outside);await writeFile(join(outside,'original.mp4'),'user media');
  const link=join(unpacked,'uploads');await symlink(outside,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(planPackageCleanup(source,['setup.exe','win-unpacked']),/contains links/);
  await assert.rejects(planPackageCleanup(source,['..']),/direct child/);
  assert.equal(await readFile(join(source,'setup.exe'),'utf8'),'installer');
  assert.equal(await readFile(join(outside,'original.mp4'),'utf8'),'user media');
  await unlink(link);
  assert.equal((await planPackageCleanup(source,['setup.exe','win-unpacked'])).length,2);
} finally {await rm(deliveryFixture,{recursive:true,force:true});}
const metadata = yaml.load(windowsUpdateMetadata('0.2.20', 'ZuorenJiandao-Setup-0.2.20-x64.exe', bytes, '2026-10-04T00:00:00.000Z'));
assert.equal(metadata.files[0].sha512, createHash('sha512').update(bytes).digest('base64'));
assert.equal(metadata.files[0].size, bytes.length);
assert.equal(metadata.path, metadata.files[0].url);
const wrapper = await readFile(new URL('./package-windows.mjs', import.meta.url), 'utf8');
assert.match(wrapper, /verifyWindowsPackage\(\{ output \}\)/);
assert.match(wrapper, /assertArtifactSpace\(ensureManagedTestRoot\(testArtifactRoot\(\)\), 4 \* 1024 \*\* 3\)/,
  'managed scratch availability must be checked before launching the Windows builder');
assert.match(wrapper, /resolve\(process\.env\.CC_EB_OUTPUT\?\.trim\(\)\s*\|\|\s*'release'\)/);
assert.match(wrapper, /writeFileSync\(join\(output, 'latest\.yml'\)/);
assert.match(wrapper, /verify-packaged-isolated\.mjs/);
assert.match(wrapper, /NODE_PATH: '', NODE_OPTIONS: ''/);
assert.match(wrapper, /result.status !== 0/);
const isolated = await readFile(new URL('./verify-packaged-isolated.mjs', import.meta.url), 'utf8');
assert.match(isolated, /await runSmoke\('write', true\)/);
assert.match(isolated, /await runSmoke\('read', false\)/);
assert.match(isolated, /OPENCHATCUT_DEV_PROFILE_ID: profileId/);
assert.match(isolated, /CHROME_LOG_FILE: join\(profile, `chrome-\$\{phase\}-\$\{runStamp\}\.log`\)/,
  'each smoke phase must redirect Chromium logs into its sibling isolated profile');
const builderConfig = (await import('../config/electron-builder.config.mjs')).default;
const chromeResource = builderConfig.extraResources.find((entry) => entry.to === 'chrome-headless-shell');
assert.deepEqual(chromeResource.filter, ['**/*', '!**/debug.log'],
  'exclude only the exact Chromium diagnostic filename, not runtime assets');
const prepareSource = await readFile(new URL('../desktop/prepare-target.mts', import.meta.url), 'utf8');
assert.match(prepareSource, /await rm\(STAGING, \{ recursive: true, force: true \}\);[\s\S]*await cp\(chromeDir, join\(STAGING, t\.cft\), \{ recursive: true, filter: isChromeRuntimeAsset \}\)/,
  'staging must clear the known output tree before the filtered copy, including stale debug.log');
const chromeFixture = await mkdtemp(join(tmpdir(), 'zuoren-chrome-stage-'));
try {
  const cached = join(chromeFixture, 'cache', 'win64');
  const runtime = join(cached, 'chrome-headless-shell-win64');
  const staged = join(chromeFixture, 'desktop-dist', 'chrome-headless-shell', 'win64');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'chrome-headless-shell.exe'), 'runtime fixture');
  await writeFile(join(runtime, 'debug.log'), 'cached diagnostics');
  await writeFile(join(runtime, 'debug.log.backup'), 'different filename fixture');
  await cp(cached, staged, { recursive: true, filter: isChromeRuntimeAsset });
  const copied = join(staged, 'chrome-headless-shell-win64');
  await assert.rejects(stat(join(copied, 'debug.log')), { code: 'ENOENT' });
  assert.equal(await readFile(join(copied, 'chrome-headless-shell.exe'), 'utf8'), 'runtime fixture');
  assert.equal(await readFile(join(copied, 'debug.log.backup'), 'utf8'), 'different filename fixture');
  assert.equal(await readFile(join(runtime, 'debug.log'), 'utf8'), 'cached diagnostics',
    'staging must preserve the original cached diagnostic evidence');
} finally {
  assert.equal(dirname(resolve(chromeFixture)), resolve(tmpdir()));
  assert.ok(basename(chromeFixture).startsWith('zuoren-chrome-stage-'));
  await rm(chromeFixture, { recursive: true, force: true });
}
const ignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
const lifecycle = await mkdtemp(join(tmpdir(), 'zuoren-package-lifecycle-'));
const savedEnv = Object.fromEntries(['CC_TEST_ARTIFACT_ROOT','CC_TEST_MIN_FREE_BYTES','CC_TEST_MAX_BYTES'].map(k=>[k,process.env[k]]));
try {
  process.env.CC_TEST_ARTIFACT_ROOT=join(lifecycle,'managed');
  process.env.CC_TEST_MIN_FREE_BYTES='0'; process.env.CC_TEST_MAX_BYTES='10485760';
  const output=join(lifecycle,'output');
  await mkdir(join(output,'win-unpacked','resources'),{recursive:true});
  await writeFile(join(output,'win-unpacked','ZuorenJiandao.exe'),'fake runtime');
  await writeFile(join(output,'win-unpacked','resources','app.asar'),'repro asar');
  for(const status of [0,1]) {
    let scratch;
    const run=(_node,args)=>{
      scratch=dirname(dirname(args[1]));
      const log=join(scratch,'isolated-smoke','stderr.log');
      mkdirSync(dirname(log),{recursive:true});writeFileSync(log,`fixture exit${status}`);
      return {status};
    };
    let evidence;
    if(status===0)evidence=verifyWindowsPackage({output,run});
    else assert.throws(()=>verifyWindowsPackage({output,run}),/Independent package check failed/);
    await assert.rejects(stat(scratch),{code:'ENOENT'},'owned app copy is removed on either outcome');
    evidence??=join(output,'logs',basename(scratch));
    assert.equal(await readFile(join(evidence,'isolated-smoke','stderr.log'),'utf8'),`fixture exit${status}`);
    if(status===1)assert.equal(await readFile(join(evidence,'app','resources','app.asar'),'utf8'),'repro asar');
  }
} finally {
  for(const [key,value] of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(lifecycle,{recursive:true,force:true});
}
assert.match(ignore, /^!\/scripts\/verify-packaged-isolated\.mjs$/m,
  'the required isolated acceptance script must not disappear from normal commits');
