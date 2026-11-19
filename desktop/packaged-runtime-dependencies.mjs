import { existsSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { extractFile, listPackage } from '@electron/asar';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = [
  'desktop/bootstrap.ts', 'desktop/main.ts', 'desktop/preload.ts',
  'desktop/native-asr-worker.ts', 'desktop/native-semantic-worker.ts',
  'desktop/native-clap-worker.ts', 'desktop/native-rhythm-worker.ts',
];
// These lazy branches are development/browser-only. Never exempt eager imports.
const BUILD_ONLY_LAZY = new Set(['@remotion/bundler', '@mediapipe/tasks-vision']);

export function runtimePackageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')
    || isBuiltin(specifier) || specifier === 'electron') return null;
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

export function collectRuntimePackages(projectRoot = PROJECT_ROOT) {
  const packages = new Set();
  for (const entry of ENTRIES) {
    const result = buildSync({
      absWorkingDir: projectRoot, entryPoints: [entry], bundle: true,
      platform: 'node', format: 'esm', packages: 'external',
      external: ['./app-main.mjs'], write: false, metafile: true,
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imported of output.imports) {
        if (!imported.external) continue;
        const name = runtimePackageName(imported.path);
        if (!name || (imported.kind === 'dynamic-import' && BUILD_ONLY_LAZY.has(name))) continue;
        packages.add(name);
      }
    }
  }
  return [...packages].sort();
}

export function packagedDependencyProblems(packages, manifest, entries) {
  const files = new Set(entries.map((entry) => entry.replaceAll('\\', '/')));
  return packages.flatMap((name) => {
    const problems = [];
    if (!manifest.dependencies?.[name]) problems.push(`${name}: not declared in production dependencies`);
    if (!files.has(`/node_modules/${name}/package.json`)) problems.push(`${name}: missing from app.asar root node_modules`);
    return problems;
  });
}

export const REQUIRED_PACKAGED_PRODUCT_ASSETS = [
  'dist/index.html',
  'dist/favicon.svg',
  'dist/icons.svg',
  'dist/fonts/noto-sans-sc/noto-sans-sc.css',
  'dist/fonts/smiley-sans/SmileySans-Oblique.woff2',
  'dist/luts/Sony_Slog3_s709.cube',
  'dist/thumbnails/ss-step-list.jpg',
  'dist/sound-effects',
  'dist/templates',
];

export function packagedProductAssetProblems(resourcesPath, required = REQUIRED_PACKAGED_PRODUCT_ASSETS) {
  return required.filter((relPath) => !existsSync(join(resourcesPath, relPath)));
}

/** Fail fast during package verification if Vite's bundled product assets were omitted from resources/dist. */
export function verifyPackagedProductAssets(resourcesPath) {
  const missing = packagedProductAssetProblems(resourcesPath);
  if (missing.length) {
    throw new Error(`Packaged product asset check failed under ${resourcesPath}:\n${missing.join('\n')}`);
  }
  console.log(`[packaged-assets] ${REQUIRED_PACKAGED_PRODUCT_ASSETS.length} bundled product asset paths verified`);
  return [...REQUIRED_PACKAGED_PRODUCT_ASSETS];
}

export function verifyPackagedRuntimeDependencies(archivePath, projectRoot = PROJECT_ROOT) {
  const packages = collectRuntimePackages(projectRoot);
  const manifest = JSON.parse(extractFile(archivePath, 'package.json').toString('utf8'));
  const problems = packagedDependencyProblems(packages, manifest, listPackage(archivePath));
  if (problems.length) throw new Error(`Packaged runtime dependency check failed:\n${problems.join('\n')}`);
  console.log(`[packaged-dependencies] ${packages.length} runtime packages are declared and present in app.asar`);
  return packages;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node desktop/packaged-runtime-dependencies.mjs path/to/app.asar');
  verifyPackagedRuntimeDependencies(resolve(process.argv[2]));
}

export function verifyRuntimeDependencyDeclarations(projectRoot = PROJECT_ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  const packages = collectRuntimePackages(projectRoot);
  const missing = packages.filter((name) => !manifest.dependencies?.[name]);
  if (missing.length) throw new Error(`Undeclared runtime dependencies: ${missing.join(', ')}`);
  return packages;
}
