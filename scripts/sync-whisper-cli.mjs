// Provision whisper.cpp CLI and its complete runtime directory.
// Offline preparation uses OPENCHATCUT_WHISPER_ARCHIVE (official zip) or
// OPENCHATCUT_WHISPER_RUNTIME_DIR (a complete runtime directory). Inputs are
// validated and staged before an atomic rename, so failures preserve a good
// installed runtime.
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = process.env.OPENCHATCUT_WHISPER_OUTPUT_DIR || join(ROOT, 'public', 'whisper-cli');
const BUILD_CACHE = join(ROOT, '.cache', 'whisper-cli');
export const VERSION = 'v1.9.2';
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}`;
export const OFFLINE_ARCHIVE_ENV = 'OPENCHATCUT_WHISPER_ARCHIVE';
export const OFFLINE_RUNTIME_ENV = 'OPENCHATCUT_WHISPER_RUNTIME_DIR';
export const OFFLINE_FLAG = '--offline';

export const PLATFORMS = {
  'darwin-arm64': { asset: null, executable: 'whisper-cli', note: 'compile from source; OPENCHATCUT_WHISPER_CLI overrides' },
  'darwin-x64': { asset: null, executable: 'whisper-cli', note: 'no official darwin-x64 asset; compile from source' },
  'win32-x64': { asset: 'whisper-bin-x64.zip', archiveBytes: 8_194_445, archiveSha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a', executable: 'whisper-cli.exe' },
  'linux-x64': { asset: 'whisper-bin-ubuntu-x64.tar.gz', archiveBytes: 9_497_583, archiveSha256: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1', executable: 'whisper-cli' },
  'linux-arm64': { asset: 'whisper-bin-ubuntu-arm64.tar.gz', archiveBytes: 4_572_842, archiveSha256: '7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719', executable: 'whisper-cli' },
};

const sha256Of = (buffer) => createHash('sha256').update(buffer).digest('hex');
export const MIN_WHISPER_BINARY_BYTES = 64 * 1024;
export const PROVENANCE_SUFFIX = '.provenance.json';
const LEGACY_DIGEST_SUFFIX = '.sha256';

export async function fetchArchive(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Pure path policy for zip/tar member names. */
export function archiveEntriesProblem(entries) {
  const seen = new Set();
  for (const raw of entries) {
    const name = String(raw).replaceAll('\\', '/').replace(/\/+$/, '');
    if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return `unsafe archive entry: ${raw}`;
    const parts = name.split('/');
    if (parts.includes('..') || parts.includes('')) return `unsafe archive entry: ${raw}`;
    const normalized = posix.normalize(name);
    if (normalized !== name || seen.has(normalized)) return `duplicate or non-normalized archive entry: ${raw}`;
    seen.add(normalized);
  }
  return null;
}
export const validateArchiveEntries = archiveEntriesProblem;

export function archiveProblem(bytes, spec) {
  if (bytes.length !== spec.archiveBytes) return `archive is ${bytes.length} bytes, pinned size is ${spec.archiveBytes}`;
  const digest = sha256Of(bytes);
  if (digest !== spec.archiveSha256) return `archive sha256 ${digest} does not match the pinned ${spec.archiveSha256}`;
  return null;
}
export function helpProbeProblem(code, output) {
  if (code !== 0) return `\`--help\` exited ${code}`;
  if (output.length < 200) return '`--help` printed no usable output';
  if (!/usage:/i.test(output)) return '`--help` output is not a whisper usage banner';
  return null;
}
export function provisionedProblem({ expected, record, binary, probe, files }) {
  if (!record) return 'no provenance record';
  const candidate = new Set(['override', 'adopted', 'runtime-dir', 'runtime-dir/candidate']);
  if (!candidate.has(record.source)) {
    if (record.version !== expected.version) return `provisioned from ${record.version ?? 'an unrecorded version'}, want ${expected.version}`;
    if (record.archiveSha256 !== expected.archiveSha256) return 'provenance archive digest does not match the pinned digest';
  }
  if (!binary) return 'binary is missing';
  if (binary.bytes < MIN_WHISPER_BINARY_BYTES) return `binary is only ${binary.bytes} bytes (minimum ${MIN_WHISPER_BINARY_BYTES})`;
  if (!binary.executable) return 'binary is not executable';
  if (binary.sha256 !== record.binarySha256) return 'binary does not match its provenance digest';
  if (!Array.isArray(record.files)) return 'provenance file manifest is missing';
  if (files && JSON.stringify(record.files) !== JSON.stringify(files)) return 'runtime files do not match their provenance manifest';
  return probe?.problem ?? null;
}
export function adoptable({ binary, probe }) { return Boolean(binary) && binary.bytes >= MIN_WHISPER_BINARY_BYTES && binary.executable && !probe?.problem; }
export function offlineDecision({ offline, hasInput, existingProblem }) { if (!offline || hasInput) return 'provision'; return existingProblem ? 'error' : 'noop'; }

async function readProvenance(binPath) { try { const parsed = JSON.parse(await readFile(binPath + PROVENANCE_SUFFIX, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; } }
async function inspectBinary(binPath) { try { const info = await stat(binPath); if (!info.isFile()) return null; return { bytes: info.size, executable: process.platform === 'win32' || (info.mode & 0o111) !== 0, sha256: sha256Of(await readFile(binPath)) }; } catch { return null; } }
async function probeHelp(binPath) { const { execFile } = await import('node:child_process'); return await new Promise((resolve) => execFile(binPath, ['--help'], { timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => { const output = `${stdout ?? ''}${stderr ?? ''}`; resolve({ problem: helpProbeProblem(error ? (error.code ?? 1) : 0, output) }); })); }
export async function fileManifest(root) { const result = []; async function visit(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { if (entry.name.endsWith(PROVENANCE_SUFFIX) || entry.name.endsWith(LEGACY_DIGEST_SUFFIX)) continue; const full = join(dir, entry.name); if (entry.isDirectory()) await visit(full); else if (entry.isFile()) { const bytes = await readFile(full); result.push({ path: relative(root, full).split('\\').join('/'), bytes: bytes.length, sha256: sha256Of(bytes) }); } } } await visit(root); return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); }
async function writeProvenance(binPath, record) { await rm(binPath + LEGACY_DIGEST_SUFFIX, { force: true }); await writeFile(binPath + PROVENANCE_SUFFIX, `${JSON.stringify(record, null, 2)}\n`); }
async function installedRecord(binPath, source, spec, extra = {}) { const binary = await inspectBinary(binPath); if (!binary) throw new Error(`whisper-cli missing after provisioning: ${binPath}`); const candidate = new Set(['override', 'adopted', 'runtime-dir', 'runtime-dir/candidate']).has(source); return { version: VERSION, platform: `${process.platform}-${process.arch}`, source, asset: candidate ? null : (spec.asset ?? null), archiveSha256: candidate ? null : (spec.archiveSha256 ?? null), binaryBytes: binary.bytes, binarySha256: binary.sha256, files: await fileManifest(dirname(binPath)), ...extra }; }

export async function findExecutable(dir, executable) { const entries = await readdir(dir, { withFileTypes: true }); for (const entry of entries) if (!entry.isDirectory() && entry.name === executable) return join(dir, entry.name); for (const entry of entries) { if (!entry.isDirectory()) continue; const hit = await findExecutable(join(dir, entry.name), executable); if (hit) return hit; } return null; }
export async function flattenExecutableDir(targetDir, executable) { const found = await findExecutable(targetDir, executable); if (!found) throw new Error(`${executable} not found under ${targetDir}`); const sourceDir = dirname(found); if (sourceDir !== targetDir) { for (const name of await readdir(sourceDir)) { const to = join(targetDir, name); await rm(to, { recursive: true, force: true }); await rename(join(sourceDir, name), to); } await rm(sourceDir, { recursive: true, force: true }); } const binPath = join(targetDir, executable); if (!existsSync(binPath)) throw new Error(`${executable} missing after flatten: ${binPath}`); return binPath; }

async function listArchiveEntries(archive) { const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const { stdout } = await promisify(execFile)('tar', ['-tf', archive], { maxBuffer: 16 << 20 }); return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
export async function extractArchive(archive, outDir) { const problem = archiveEntriesProblem(await listArchiveEntries(archive)); if (problem) throw new Error(problem); await mkdir(outDir, { recursive: true }); const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); await promisify(execFile)('tar', ['-xf', archive, '-C', outDir], { maxBuffer: 16 << 20 }); }
export async function copyRuntimeDirectory(sourceDir, destinationDir) { const info = await stat(sourceDir); if (!info.isDirectory()) throw new Error(`runtime directory is not a directory: ${sourceDir}`); await mkdir(destinationDir, { recursive: true }); await cp(sourceDir, destinationDir, { recursive: true, force: true, errorOnExist: false, filter: (source) => !source.endsWith(PROVENANCE_SUFFIX) && !source.endsWith(LEGACY_DIGEST_SUFFIX) }); }

async function buildFromSource(srcDir, buildDir) { const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util'); const run = promisify(execFile); const binName = `whisper-cli${process.platform === 'win32' ? '.exe' : ''}`; const builtCli = join(buildDir, 'build', 'bin', binName); if (existsSync(builtCli)) return builtCli; if (!existsSync(join(srcDir, 'CMakeLists.txt'))) { await rm(srcDir, { recursive: true, force: true }); await run('git', ['clone', '--depth', '1', '--branch', VERSION, 'https://github.com/ggml-org/whisper.cpp.git', srcDir]); } const metalFlag = process.platform === 'darwin' ? ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] : []; try { await run('cmake', ['--version']); } catch { throw new Error('cmake is required to build whisper.cpp; or set OPENCHATCUT_WHISPER_CLI to a prebuilt binary'); } await run('cmake', ['-B', join(buildDir, 'build'), '-DCMAKE_BUILD_TYPE=Release', ...metalFlag, srcDir]); await run('cmake', ['--build', join(buildDir, 'build'), '--config', 'Release', '-j', '--target', 'whisper-cli', 'whisper-server']); return builtCli; }
async function prepareOverride(override, stageDir, spec) { await copyRuntimeDirectory(dirname(override), stageDir); const bin = await flattenExecutableDir(stageDir, spec.executable); if (process.platform !== 'win32') await chmod(bin, 0o755); return installedRecord(bin, 'override', spec); }
async function prepareRuntimeDir(source, stageDir, spec) { await copyRuntimeDirectory(source, stageDir); const bin = await flattenExecutableDir(stageDir, spec.executable); if (process.platform !== 'win32') await chmod(bin, 0o755); return installedRecord(bin, 'runtime-dir', spec, { candidate: true }); }
async function prepareArchive(source, stageDir, spec, provenanceSource) { const bytes = new Uint8Array(await readFile(source)); const problem = archiveProblem(bytes, spec); if (problem) throw new Error(`refusing ${source}: ${problem}`); await extractArchive(source, stageDir); const bin = await flattenExecutableDir(stageDir, spec.executable); if (process.platform !== 'win32') await chmod(bin, 0o755); return installedRecord(bin, provenanceSource, spec, { archiveBytes: bytes.length }); }
async function prepareAsset(stageDir, spec, platformKey) { const url = `${BASE}/${spec.asset}`; console.log(`[whisper-cli] downloading ${url}`); const bytes = await fetchArchive(url); const problem = archiveProblem(bytes, spec); if (problem) throw new Error(`refusing ${spec.asset}: ${problem}`); const archive = join(dirname(stageDir), `${platformKey}.${spec.asset.endsWith('.zip') ? 'zip' : 'tar.gz'}`); await writeFile(archive, bytes); try { return await prepareArchive(archive, stageDir, spec, 'asset'); } finally { await rm(archive, { force: true }); } }
async function prepareSource(stageDir, spec, platformKey) { const cli = await buildFromSource(join(BUILD_CACHE, 'whisper.cpp'), BUILD_CACHE); await copyRuntimeDirectory(dirname(cli), stageDir); const bin = await flattenExecutableDir(stageDir, spec.executable); await chmod(bin, 0o755); console.log(`[whisper-cli] built ${platformKey} from source`); return installedRecord(bin, 'build', spec); }

export async function atomicPublish(stagingDir, targetDir) { const backup = `${targetDir}.previous-${process.pid}`; await rm(backup, { recursive: true, force: true }); let oldMoved = false; let newMoved = false; try { if (existsSync(targetDir)) { await rename(targetDir, backup); oldMoved = true; } await rename(stagingDir, targetDir); newMoved = true; if (oldMoved) await rm(backup, { recursive: true, force: true }); } catch (error) { if (newMoved && existsSync(targetDir)) await rm(targetDir, { recursive: true, force: true }); if (oldMoved && existsSync(backup)) await rename(backup, targetDir); throw error; } }
async function inspectProvisioned(binPath, spec) { const record = await readProvenance(binPath); const binary = await inspectBinary(binPath); const probe = binary ? await probeHelp(binPath) : null; const files = binary ? await fileManifest(dirname(binPath)) : null; const snapshot = { expected: { version: VERSION, archiveSha256: spec.archiveSha256 ?? null }, record, binary, probe, files }; return { ...snapshot, problem: provisionedProblem(snapshot) }; }
function requestedOffline() { return process.argv.includes(OFFLINE_FLAG) || /^(1|true|yes)$/i.test(process.env.OPENCHATCUT_WHISPER_OFFLINE ?? ''); }
async function main() { const platformKey = `${process.platform}-${process.arch}`; const spec = PLATFORMS[platformKey]; if (!spec) throw new Error(`unsupported platform ${platformKey}`); const targetDir = join(OUT_DIR, platformKey); const binPath = join(targetDir, spec.executable); const override = process.env.OPENCHATCUT_WHISPER_CLI; const archiveInput = process.env[OFFLINE_ARCHIVE_ENV]; const runtimeInput = process.env[OFFLINE_RUNTIME_ENV]; const inputs = [archiveInput, runtimeInput, override].filter(Boolean); if (inputs.length > 1) throw new Error(`choose only one of ${OFFLINE_ARCHIVE_ENV}, ${OFFLINE_RUNTIME_ENV}, OPENCHATCUT_WHISPER_CLI`); if (!inputs.length) { const state = await inspectProvisioned(binPath, spec); if (!state.problem) { console.log(`[whisper-cli] ${platformKey} verified at ${binPath}`); return; } if (requestedOffline()) throw new Error(`offline mode requires ${OFFLINE_ARCHIVE_ENV} or ${OFFLINE_RUNTIME_ENV}; existing runtime is missing or invalid (${state.problem})`); if (!spec.asset && !state.record && adoptable(state)) { await writeProvenance(binPath, await installedRecord(binPath, 'adopted', spec, { version: null })); console.log(`[whisper-cli] adopted the existing ${platformKey} binary at ${binPath}`); return; } console.log(`[whisper-cli] re-provisioning ${platformKey}: ${state.problem}`); } const stageRoot = join(OUT_DIR, `.staging-${platformKey}-${process.pid}-${Date.now()}`); const stageDir = join(stageRoot, 'runtime'); await rm(stageRoot, { recursive: true, force: true }); await mkdir(stageRoot, { recursive: true }); try { const record = archiveInput ? await prepareArchive(archiveInput, stageDir, spec, 'offline-archive') : runtimeInput ? await prepareRuntimeDir(runtimeInput, stageDir, spec) : override ? await prepareOverride(override, stageDir, spec) : spec.asset ? await prepareAsset(stageDir, spec, platformKey) : await prepareSource(stageDir, spec, platformKey); const stagedBin = join(stageDir, spec.executable); await writeProvenance(stagedBin, record); const state = await inspectProvisioned(stagedBin, spec); if (state.problem) throw new Error(`${stagedBin} failed verification: ${state.problem}`); await atomicPublish(stageDir, targetDir); console.log(`[whisper-cli] ${platformKey} ready (${record.binaryBytes} bytes, ${record.source})`); } catch (error) { await rm(stageRoot, { recursive: true, force: true }); throw error; } await rm(stageRoot, { recursive: true, force: true }); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`[whisper-cli] ${error.message}`); process.exitCode = 1; });
