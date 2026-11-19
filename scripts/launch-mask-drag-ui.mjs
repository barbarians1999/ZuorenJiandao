import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { build } from 'esbuild';
import { join, resolve, sep } from 'node:path';

const origin = 'http://127.0.0.1:39795';
const fixture = await (await fetch(`${origin}/qa/fixture`)).json();
const root = resolve(process.env.CC_MASK_DRAG_ARTIFACT_ROOT ?? 'release/mask-drag-20261014');
if (!resolve(fixture.outDir).startsWith(root + sep) || !/^[a-f0-9-]{36}$/.test(fixture.profileId)) throw new Error('Unexpected isolated fixture');
const host = join(fixture.outDir, 'electron-host.mjs');
await build({ entryPoints: ['scripts/jianying-workflow-electron.mts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: host });
const child = spawn(resolve('node_modules/electron/dist/electron.exe'), [host, '--remote-debugging-port=39796'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    OPENCHATCUT_DEV_PROFILE_ID: fixture.profileId, OPENCHATCUT_DATA_DIR: fixture.profile,
    CC_WORKFLOW_FIXTURE_URL: `${origin}/scripts/fixtures/mask-drag-ui.html`,
  },
});
const output = createWriteStream(join(fixture.outDir, 'electron.log'));
child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
child.stdout.on('data', (data) => process.stdout.write(data)); child.stderr.on('data', (data) => process.stderr.write(data));
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('close', (code) => { output.end(); process.exitCode = code ?? 1; });
console.log(`OWNED hidden mask drag host ${child.pid}, profile ${fixture.profile}`);
