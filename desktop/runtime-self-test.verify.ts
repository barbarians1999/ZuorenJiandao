import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import {
  packagedWhisperCliPath,
  probePackagedWhisper,
  runtimeSelfTestRequested,
  whisperHelpProblem,
} from './runtime-self-test.ts';

assert.equal(runtimeSelfTestRequested(['ZuorenJiandao.exe', '--runtime-self-test']), true);
assert.equal(runtimeSelfTestRequested(['ZuorenJiandao.exe', '--runtime-self-test-extra']), false);
assert.equal(whisperHelpProblem(0, `usage: whisper-cli [options]\n${'-'.repeat(220)}`), null);
assert.match(whisperHelpProblem(1, '') ?? '', /exited 1/);
assert.match(whisperHelpProblem(0, 'usage: short') ?? '', /no usable output/);
assert.match(whisperHelpProblem(0, 'x'.repeat(240)) ?? '', /not a usage banner/);

const resourcesPath = join('C:', 'Program Files', 'Zuoren Jiandao', 'resources');
const whisperCliPath = packagedWhisperCliPath(resourcesPath, 'win32', 'x64');
assert.equal(
  whisperCliPath,
  join(resourcesPath, 'dist', 'whisper-cli', 'win32-x64', 'whisper-cli.exe'),
  'the self-test must ignore external overrides and address the runtime inside resourcesPath',
);
let observed: {
  file?: string;
  args?: readonly string[];
  cwd?: string;
  timeout?: number;
  windowsHide?: boolean;
} = {};
const fakeExec = (file: string, args: string[], options: {
  cwd: string;
  timeout: number;
  windowsHide: boolean;
}, callback: (
  error: (Error & { code?: string | number | null }) | null,
  stdout: string,
  stderr: string,
) => void) => {
  observed = {
    file,
    args,
    cwd: options.cwd?.toString(),
    timeout: options.timeout,
    windowsHide: options.windowsHide,
  };
  callback(null, `usage: whisper-cli [options]\n${'-'.repeat(220)}`, '');
};

const passed = await probePackagedWhisper(resourcesPath, whisperCliPath, fakeExec);
assert.deepEqual(passed, {
  ok: true,
  resourcesPath,
  whisperCliPath,
  problem: null,
});
assert.deepEqual(observed, {
  file: whisperCliPath,
  args: ['--help'],
  cwd: dirname(whisperCliPath),
  timeout: 30_000,
  windowsHide: true,
}, 'the installed executable must be launched beside its packaged DLLs');

const missingDllExec = (file: string, args: string[], options: object,
  callback: (
    error: (Error & { code?: string | number | null }) | null,
    stdout: string,
    stderr: string,
  ) => void) => {
  void file;
  void args;
  void options;
  const error = Object.assign(new Error('DLL missing'), { code: 'ENOENT' });
  callback(error, '', '');
};
const failed = await probePackagedWhisper(resourcesPath, whisperCliPath, missingDllExec);
assert.equal(failed.ok, false);
assert.match(failed.problem ?? '', /exited 1/);

console.log('runtime-self-test.verify: packaged Whisper is started from its real resources directory');
