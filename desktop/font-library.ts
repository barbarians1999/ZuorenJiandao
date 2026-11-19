import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { DesktopFontCatalog, DesktopFontFace, DesktopFontPreview } from '../shared/desktop-fonts.ts';
import type { MediaAsset } from '../src/editor/mediaTypes.ts';
import { uploadDir } from '../server/media-dir.ts';
import { readFontFaces, standaloneFontFace } from './font-sfnt.ts';

const execFileAsync = promisify(execFile);
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const MAX_FONT_BYTES = 128 * 1024 * 1024;
interface Grant { path: string; face: DesktopFontFace; size: number; modifiedAt: number }

const WINDOWS_FONT_QUERY = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$locations=@('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts','HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts')
$entries=@(foreach($location in $locations){
  if(Test-Path -LiteralPath $location){
    $properties=(Get-ItemProperty -LiteralPath $location).PSObject.Properties
    foreach($property in $properties){
      if($property.Name -notmatch '^PS' -and $property.Value -is [string]){
        [PSCustomObject]@{filename=[string]$property.Value}
      }
    }
  }
})
ConvertTo-Json -InputObject $entries -Compress
`;

async function registeredWindowsFontPaths(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(WINDOWS_FONT_QUERY, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 30_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  const entries: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(entries)) throw new Error('无法读取 Windows 字体列表');
  const paths = new Set<string>();
  for (const raw of entries.slice(0, 10_000)) {
    const filename = raw && typeof raw === 'object' ? (raw as { filename?: unknown }).filename : undefined;
    if (typeof filename !== 'string' || !FONT_EXTENSIONS.has(extname(filename).toLowerCase())) continue;
    const expanded = filename.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? '');
    const candidates = isAbsolute(expanded) ? [expanded] : [
      join(systemRoot, 'Fonts', expanded),
      ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts', expanded)] : []),
    ];
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) { paths.add(candidate); break; } } catch { /* unavailable registered font */ }
    }
  }
  return [...paths];
}

/** Main-process grants restrict font reads to OS-registered or user-picked files. */
export function createDesktopFontLibrary(dependencies: {
  systemPaths?: () => Promise<string[]>;
  directory?: () => string;
} = {}) {
  const grants = new Map<string, Grant>();
  const pathGrants = new Map<string, DesktopFontFace[]>();
  const writes = new Map<string, Promise<void>>();
  let catalog: Promise<DesktopFontCatalog> | undefined;

  async function inspect(path: string, source: DesktopFontFace['source']): Promise<DesktopFontFace[]> {
    if (!isAbsolute(path) || !FONT_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error('请选择 TTF、OTF 或 TTC 字体文件');
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > MAX_FONT_BYTES) throw new Error('字体文件无效或超过 128 MB');
    const cacheKey = `${path}\0${info.size}\0${info.mtimeMs}\0${source}`;
    const cached = pathGrants.get(cacheKey);
    if (cached) return cached;
    const bytes = await readFile(path);
    const after = await stat(path);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('字体文件读取期间发生变化，请重新选择');
    const faces = readFontFaces(bytes).map((metadata): DesktopFontFace => ({
      ...metadata, faceId: randomUUID(), source, filename: basename(path),
    }));
    for (const face of faces) grants.set(face.faceId, { path, face, size: info.size, modifiedAt: info.mtimeMs });
    pathGrants.set(cacheKey, faces);
    return faces;
  }

  async function selectedFace(faceId: unknown) {
    if (typeof faceId !== 'string' || !grants.has(faceId)) throw new Error('字体选择已失效，请重新打开字体列表');
    const grant = grants.get(faceId)!;
    const before = await stat(grant.path);
    if (!before.isFile() || before.size !== grant.size || before.mtimeMs !== grant.modifiedAt) throw new Error('字体文件已经变化或不可用，请重新导入');
    const raw = await readFile(grant.path);
    const after = await stat(grant.path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('字体读取期间发生变化，请重试');
    return { ...standaloneFontFace(raw, grant.face.faceIndex), face: grant.face };
  }

  return {
    inspect,
    listSystemFonts(refresh = false): Promise<DesktopFontCatalog> {
      if (refresh) catalog = undefined;
      if (catalog) return catalog;
      catalog = (async () => {
        const faces: DesktopFontFace[] = [];
        let unreadableFiles = 0;
        for (const path of await (dependencies.systemPaths ?? registeredWindowsFontPaths)()) {
          try { faces.push(...await inspect(path, 'system')); } catch { unreadableFiles++; }
        }
        faces.sort((left, right) => left.family.localeCompare(right.family, 'zh-CN') || left.weight - right.weight || left.style.localeCompare(right.style));
        return { faces, unreadableFiles };
      })().catch((error: unknown) => { catalog = undefined; throw error; });
      return catalog;
    },
    async previewFont(faceId: unknown): Promise<DesktopFontPreview> {
      const selected = await selectedFace(faceId);
      return { face: selected.face, bytes: selected.bytes };
    },
    async materializeFont(faceId: unknown): Promise<MediaAsset> {
      const selected = await selectedFace(faceId);
      const hash = createHash('sha256').update(selected.bytes).digest('hex');
      const directory = (dependencies.directory ?? uploadDir)();
      await mkdir(directory, { recursive: true });
      const storedName = `font-${hash}${selected.extension}`, path = join(directory, storedName);
      let write = writes.get(path);
      if (!write) {
        write = (async () => {
          let handle;
          let created = false;
          let written = false;
          try {
            handle = await open(path, 'wx');
            created = true;
            await handle.writeFile(selected.bytes); await handle.sync(); written = true;
          } catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
            const existing = await readFile(path);
            if (createHash('sha256').update(existing).digest('hex') !== hash) throw new Error('已保存的字体校验失败，请检查素材目录');
          } finally {
            await handle?.close();
            if (created && !written) await unlink(path);
          }
        })().finally(() => writes.delete(path));
        writes.set(path, write);
      }
      await write;
      return {
        id: `font_${hash}`, kind: 'file', name: selected.metadata.fullName,
        sourceFilename: selected.face.filename, src: `/media/uploads/${storedName}`,
        durationInFrames: 0, sourceContentHash: hash, sourceSize: selected.bytes.length,
        props: { resourceType: 'font', font: { ...selected.metadata, source: selected.face.source,
          format: selected.extension === '.otf' ? 'opentype' : 'truetype' } },
      };
    },
  };
}
