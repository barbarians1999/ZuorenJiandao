import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';

export const RUNTIME_SELF_TEST_FLAG = '--runtime-self-test';
const WHISPER_HELP_TIMEOUT_MS = 30_000;
const WHISPER_HELP_MAX_BUFFER = 8 << 20;

export interface RuntimeSelfTestResult {
  readonly ok: boolean;
  readonly resourcesPath: string;
  readonly whisperCliPath: string;
  readonly problem: string | null;
}

interface RuntimeProbeExecOptions {
  readonly cwd: string;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly windowsHide: boolean;
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: RuntimeProbeExecOptions,
  callback: (
    error: (Error & { code?: string | number | null }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

const runExecFile: ExecFileLike = (file, args, options, callback) => execFile(
  file,
  args,
  { ...options, encoding: 'utf8' },
  (error, stdout, stderr) => callback(error, stdout, stderr),
);

export function runtimeSelfTestRequested(argv: readonly string[]): boolean {
  return argv.includes(RUNTIME_SELF_TEST_FLAG);
}

export function packagedWhisperCliPath(
  resourcesPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const executable = platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return join(resourcesPath, 'dist', 'whisper-cli', `${platform}-${arch}`, executable);
}

export function whisperHelpProblem(code: number, output: string): string | null {
  if (code !== 0) return `whisper-cli --help exited ${code}`;
  if (output.length < 200) return 'whisper-cli --help printed no usable output';
  if (!/usage:/i.test(output)) return 'whisper-cli --help output is not a usage banner';
  return null;
}

export function probePackagedWhisper(
  resourcesPath: string,
  whisperCliPath: string,
  run: ExecFileLike = runExecFile,
): Promise<RuntimeSelfTestResult> {
  return new Promise((resolve) => {
    run(whisperCliPath, ['--help'], {
      cwd: dirname(whisperCliPath),
      timeout: WHISPER_HELP_TIMEOUT_MS,
      maxBuffer: WHISPER_HELP_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      const code = error
        ? (typeof error.code === 'number' ? error.code : 1)
        : 0;
      const problem = whisperHelpProblem(code, output);
      resolve({
        ok: problem === null,
        resourcesPath,
        whisperCliPath,
        problem,
      });
    });
  });
}
