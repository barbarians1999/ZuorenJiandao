import { randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { browseLocalMedia } from '../../desktop/agent-local-media.ts';
import { importAgentPaths } from '../../desktop/agent-path-import.ts';
import { isAgentLocalMediaRequest } from '../../shared/agent-local-media.ts';
import type { AgentContext } from '../../src/agent/context.js';
import {
  findUploadAsset,
  isUploadSourceType,
  mapUploadKind,
} from '../../src/agent/tools/upload-handoff-tools.js';
import { createMediaSourceRevision } from '../../src/editor/mediaSourceRevision.js';
import type { MediaAsset } from '../../src/editor/types.js';
import { directoryFileToAsset } from '../../src/media/directoryImportAsset.js';
import { safeSourceFilename } from '../../src/media/sourceFilename.js';
import { externalUploadMediaType } from '../../src/media/uploadMediaType.js';
import { resolveUploadFile, uploadDir } from '../media-dir.ts';
import { normalizeMediaFile } from '../media-normalization-runner.ts';
import {
  abortUploadReceipt,
  claimUploadReceipt,
  commitUploadReceipt,
  mintImportUpload,
} from './import-token.ts';

type Args = Record<string, unknown>;

export const OFFLINE_MEDIA_TOOL_NAMES = new Set([
  'browse_local_media',
  'import_asset',
  'import_assets',
  'import_folder',
  'import_media',
  'finalize_uploaded_asset',
  'request_asset_download',
]);

const newId = (): string => randomUUID();

function normalizeOrigin(origin: string): string {
  const trimmed = origin.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

async function execOfflinePathImport(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<Record<string, unknown>> {
  const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
  const paths = name === 'import_assets' ? args.paths : [rawPath];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100
    || !paths.every((path): path is string => typeof path === 'string' && path.trim().length > 0)) {
    return { error: 'path is required; provide one non-empty path or 1-100 paths for import_assets' };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'no open project; target a project before importing local paths' };
  const state = ctx.getState();
  const knownHashes = ctx.getDoc().assets
    .map((asset) => asset.sourceContentHash)
    .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0);
  let result;
  try {
    result = await importAgentPaths({ paths, projectId, knownHashes });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.imported.length && result.errors.length) {
    const first = result.errors[0]!;
    return {
      error: first.error,
      ...(first.code ? { code: first.code } : {}),
      errors: result.errors.slice(0, 20),
    };
  }
  const assets = await Promise.all(result.imported.map((file) => directoryFileToAsset(
    { ...file, importId: randomUUID() },
    state.fps,
  )));
  for (const asset of assets) ctx.commands.addAsset(asset);
  return {
    ok: true,
    imported: assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      src: asset.src,
      durationInFrames: asset.durationInFrames,
      width: asset.width,
      height: asset.height,
    })),
    duplicateCount: result.duplicateCount,
    skippedDuplicates: result.duplicateCount > 0
      && !assets.length && !result.errors.length && !result.unsupportedFiles.length,
    ...(result.unsupportedFiles.length ? { unsupportedFiles: result.unsupportedFiles.slice(0, 50) } : {}),
    ...(result.errors.length ? { errors: result.errors.slice(0, 20) } : {}),
  };
}

async function execOfflineImportMedia(
  args: Args,
  ctx: AgentContext,
  origin: string,
): Promise<Record<string, unknown>> {
  if (args.action !== 'create_session') {
    return { error: 'import_media action must be create_session' };
  }
  if (!isUploadSourceType(args.assetType)) {
    return { error: 'assetType must be audio|gif|image|svg|video' };
  }
  const contentType = String(args.contentType ?? '').trim();
  const filename = safeSourceFilename(args.filename);
  const mediaType = externalUploadMediaType(args.assetType, contentType);
  const size = Number(args.size);
  if (!mediaType) return { error: 'assetType and contentType must be a supported media pair' };
  if (!filename) return { error: 'filename must be a safe basename' };
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { error: 'size must be a positive integer byte count' };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'a persisted project is required for external upload handoff' };
  const requestedAssetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
  const existing = requestedAssetId ? findUploadAsset(ctx, requestedAssetId) : null;
  if (requestedAssetId && !existing) return { error: `asset not found: ${requestedAssetId}` };
  const kind = mapUploadKind(args.assetType);
  if (existing && kind !== existing.kind) {
    return { error: `asset ${existing.id} is ${existing.kind}, not ${kind}` };
  }
  const sessionId = `sess_${newId()}`;
  const assetId = existing?.id ?? newId();
  const uploadName = `${assetId}.${sessionId}${mediaType.extension}`;
  const fileKey = `uploads/${uploadName}`;
  const readUrl = `/media/${fileKey}`;
  const minted = mintImportUpload({
    sessionId,
    assetId,
    assetType: args.assetType,
    filename,
    projectId,
    method: 'POST',
    contentType,
    expectedBytes: size,
  });
  const baseOrigin = normalizeOrigin(origin);
  const uploadUrl = baseOrigin ? new URL(minted.uploadUrl, baseOrigin).href : minted.uploadUrl;
  const slot = {
    ok: true,
    slotId: assetId,
    assetId,
    existingAsset: Boolean(existing),
    fileKey,
    readUrl,
    uploadUrl,
    method: 'POST',
    allowedMethods: minted.allowedMethods,
    expiresAt: minted.expiresAt,
    expiresInSeconds: minted.expiresInSeconds,
    headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
    contentType,
    filename,
    size,
    assetType: args.assetType,
    state: 'awaiting_upload',
  };
  return {
    ok: true,
    action: 'create_session',
    sessionId,
    projectId,
    state: 'awaiting_upload',
    slots: [slot],
    next: [
      'Upload once to the exact slot uploadUrl before expiry with the declared headers.',
      'Pass the opaque receipt and echoed assetType to finalize_uploaded_asset; audio/video/gif also require durationInSeconds.',
      'The asset becomes consumable only after finalize succeeds.',
    ],
    note: 'Import session created with one verified, filename-scoped, short-lived, single-use slot.',
  };
}

function validateOfflineFinalizeArgs(args: Args): { receipt: string; error?: string } {
  const receipt = typeof args.receipt === 'string' ? args.receipt.trim() : '';
  if (!receipt) return { receipt, error: 'receipt is required' };
  if (!isUploadSourceType(args.assetType)) {
    return { receipt, error: 'assetType must be audio, gif, image, svg, or video' };
  }
  const needsDuration = args.assetType === 'audio' || args.assetType === 'gif' || args.assetType === 'video';
  if (needsDuration && (
    typeof args.durationInSeconds !== 'number'
    || !Number.isFinite(args.durationInSeconds)
    || args.durationInSeconds <= 0
  )) {
    return { receipt, error: 'durationInSeconds is required for audio/video/gif and must be positive' };
  }
  for (const field of ['durationInSeconds', 'width', 'height', 'fps'] as const) {
    const value = args[field];
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    )) {
      return { receipt, error: `${field} must be a positive finite number` };
    }
  }
  return { receipt };
}

function finalizeDurationFrames(args: Args, kind: MediaAsset['kind'], type: string, fps: number): number | null {
  if (kind === 'image' && type !== 'gif') return Math.round(3 * fps);
  if (typeof args.durationInSeconds === 'number' && args.durationInSeconds > 0) {
    return Math.max(1, Math.round(args.durationInSeconds * fps));
  }
  if (kind === 'image') return Math.round(3 * fps);
  return null;
}

async function execOfflineFinalizeUpload(args: Args, ctx: AgentContext): Promise<Record<string, unknown>> {
  const preliminary = validateOfflineFinalizeArgs(args);
  if (preliminary.error) return { error: preliminary.error };
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'a persisted project is required to finalize an upload receipt' };
  const claimId = randomBytes(24).toString('base64url');
  const claimed = claimUploadReceipt(preliminary.receipt, projectId, claimId);
  if (claimed.status !== 'accepted') {
    return { error: 'upload receipt is invalid, expired, consumed, claimed, or outside this project' };
  }
  const input = claimed.value;
  try {
    if (args.assetType !== input.type) {
      throw new Error(`assetType does not match the trusted upload receipt (${input.type})`);
    }
    const kind = mapUploadKind(input.type);
    if (!kind) throw new Error(`unsupported type ${input.type}`);
    const fps = ctx.getState().fps || 30;
    let durationInFrames = finalizeDurationFrames(args, kind, input.type, fps);
    if (durationInFrames === null) throw new Error('durationInSeconds is required for audio/video/gif');
    let src = input.readUrl;
    let width = typeof args.width === 'number' && args.width > 0 ? args.width : undefined;
    let height = typeof args.height === 'number' && args.height > 0 ? args.height : undefined;
    let finalSize = input.size;
    let normalized = false;
    if (kind === 'video' && input.readUrl.startsWith('/media/uploads/')) {
      const inputPath = resolveUploadFile(basename(input.readUrl));
      if (!inputPath) throw new Error('uploaded video file could not be resolved on disk');
      const result = await normalizeMediaFile({
        inputPath,
        publicSrc: input.readUrl,
        preserveInput: false,
        publishR2: false,
        uploadsDirectory: uploadDir(),
      });
      src = result.path;
      width = result.width ?? width;
      height = result.height ?? height;
      finalSize = result.bytes ?? finalSize;
      normalized = result.normalized;
      if (result.durationSeconds && result.durationSeconds > 0) {
        durationInFrames = Math.max(1, Math.round(result.durationSeconds * fps));
      }
    }
    const sourceRevision = createMediaSourceRevision({
      src: input.readUrl,
      sourceContentHash: input.contentHash,
    });
    const existing = findUploadAsset(ctx, input.assetId);
    const asset: MediaAsset = {
      id: input.assetId,
      name: input.filename,
      sourceFilename: input.filename,
      kind,
      src,
      durationInFrames,
      sourceRevision,
      sourceContentHash: input.contentHash,
      sourceSize: finalSize,
      ...(width ?? existing?.width ? { width: width ?? existing?.width } : {}),
      ...(height ?? existing?.height ? { height: height ?? existing?.height } : {}),
    };
    if (!existing) {
      ctx.commands.addAsset(asset);
    } else {
      ctx.commands.relinkMediaAsset(existing.id, {
        src: asset.src,
        name: asset.name,
        sourceFilename: asset.sourceFilename,
        originalFilePath: undefined,
        durationInFrames: asset.durationInFrames,
        width: asset.width,
        height: asset.height,
        kind: asset.kind,
        sourceRevision: asset.sourceRevision,
        sourceContentHash: asset.sourceContentHash,
        sourceSize: asset.sourceSize,
      });
    }
    if (!commitUploadReceipt(preliminary.receipt, projectId, claimId)) {
      throw new Error('upload receipt commit failed');
    }
    const offersTranscription = kind === 'audio' || (kind === 'video' && args.hasAudioTrack !== false);
    return {
      ok: true,
      sessionId: input.sessionId,
      ...(existing ? { alreadyRegistered: true, replacedExistingAsset: true } : {}),
      assetId: asset.id,
      name: asset.name,
      type: asset.kind,
      sourceType: input.type,
      src: asset.src,
      fileKey: `uploads/${asset.src.slice('/media/uploads/'.length)}`,
      size: asset.sourceSize,
      contentHash: input.contentHash,
      sourceRevision: asset.sourceRevision,
      sourceContentHash: input.contentHash,
      normalized: normalized || undefined,
      durationInFrames: asset.durationInFrames,
      width: asset.width,
      height: asset.height,
      receiptCommit: 'committed',
      transcription: offersTranscription ? 'not_started' : undefined,
      note: existing
        ? 'Existing asset replaced from a verified import receipt.'
        : 'Asset registered in media pool (offline finalize).',
    };
  } catch (error) {
    abortUploadReceipt(preliminary.receipt, projectId, claimId);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function execOfflineRequestDownload(args: Args, ctx: AgentContext, origin: string): Record<string, unknown> {
  const q = String(args.assetId ?? '').trim();
  if (!q) return { error: 'assetId is required' };
  if (args.variant != null && args.variant !== 'source') {
    return { error: 'only variant "source" is supported' };
  }
  const asset = findUploadAsset(ctx, q);
  if (!asset) return { error: `asset not found: ${q}` };
  if (!asset.src) {
    return {
      error: 'asset has no source media file (e.g. motion-graphic without baked video)',
      hint: 'Export MG via export_motion_graphic_prores or convert_motion_graphic_to_video first.',
    };
  }
  const baseOrigin = normalizeOrigin(origin);
  const downloadUrl = asset.src.startsWith('http')
    ? asset.src
    : baseOrigin
      ? `${baseOrigin}${asset.src.startsWith('/') ? '' : '/'}${asset.src}`
      : asset.src;
  return {
    ok: true,
    localDev: true,
    assetId: asset.id,
    name: asset.name,
    type: asset.kind,
    variant: 'source',
    path: asset.src,
    downloadUrl,
    note: 'Open downloadUrl in the browser or use as <a download>. Local-dev has no signed expiry.',
  };
}

/** Execute dependency-closed local-path import and HTTP upload handoff tools on the server. */
export async function execOfflineMediaTool(
  name: string,
  args: Args,
  ctx: AgentContext,
  origin = '',
): Promise<Record<string, unknown>> {
  if (name === 'browse_local_media') {
    if (!isAgentLocalMediaRequest(args)) return { error: 'invalid local media browse request' };
    try {
      return { ok: true, ...await browseLocalMedia(args) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (name === 'import_asset' || name === 'import_assets' || name === 'import_folder') {
    return execOfflinePathImport(name, args, ctx);
  }
  if (name === 'import_media') {
    return execOfflineImportMedia(args, ctx, origin);
  }
  if (name === 'finalize_uploaded_asset') {
    return execOfflineFinalizeUpload(args, ctx);
  }
  if (name === 'request_asset_download') {
    return execOfflineRequestDownload(args, ctx, origin);
  }
  return { error: `unknown offline media tool ${name}` };
}
