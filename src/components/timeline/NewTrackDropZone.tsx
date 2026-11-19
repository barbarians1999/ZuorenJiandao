import type { DragEvent } from 'react';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState, TrackKind } from '../../editor/types';
import { parseEditorDrag, mediaAssetIds, mediaSourceRangeFor } from '../../editor/editorDrag';
import { resolveMediaSourceRange } from '../../editor/mediaSourceRange';
import { mediaAssetTrackKind } from '../../media/drag';
import { mediaPlacementVolume } from '../../media/placementPurpose';
import { classifyExternalFile, droppedFiles, hasExternalFiles } from '../../media/externalFileDrop';
import { useT } from '../../i18n/locale';
import { parseLibraryDrag } from '../../library/drag';
import { placeSound, soundAssetForId } from '../../audio/soundPlacement';
import { showAppToast } from '../../ui/appToast';
import { HEADER_W } from './timelineUtil';

export function NewTrackDropZone({ state, commands, frameFromClientX, onDropExternalFiles, top = false, activePlacement = null, labelOverride }: {
  state: TimelineState; commands: EditorCommands; frameFromClientX: (x: number) => number;
  onDropExternalFiles?: (files: File[], track: string, frame: number) => void; top?: boolean;
  activePlacement?: 'top' | 'bottom' | null; labelOverride?: string;
}) {
  const t = useT();
  const accepts = (event: DragEvent) => hasExternalFiles(event.dataTransfer)
    || Array.from(event.dataTransfer.types).includes('application/x-openchatcut-editor-item');
  const drop = (event: DragEvent) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.classList.remove('drag-over');
    const frame = frameFromClientX(event.clientX);
    const tracks = new Map<TrackKind, string>();
    const destination = (kind: TrackKind) => {
      let id = tracks.get(kind);
      if (!id) {
        const order = kind === 'video' ? (top ? undefined : 0) : (top ? 0 : undefined);
        id = commands.createTrack(kind, { order });
        tracks.set(kind, id);
      }
      return id;
    };
    const files = droppedFiles(event.dataTransfer);
    if (files.length && onDropExternalFiles) {
      const groups = new Map<TrackKind, File[]>();
      for (const file of files) {
        const target = classifyExternalFile(file);
        if (!target) continue;
        const kind = target.type === 'caption' ? 'caption' : target.mediaKind === 'audio' ? 'audio' : 'video';
        groups.set(kind, [...(groups.get(kind) ?? []), file]);
      }
      for (const [kind, group] of groups) onDropExternalFiles(group, destination(kind), frame);
      return;
    }
    const library = parseLibraryDrag(event);
    if (library?.kind === 'sound') {
      const asset = soundAssetForId(library.id, state.fps);
      if (!asset) { showAppToast(t('未找到这个本地音效，未添加。'), { error: true }); return; }
      placeSound(state, commands, asset, { startFrame: frame, newTrack: true },
        (message) => showAppToast(message, { error: true }));
      return;
    }
    const payload = parseEditorDrag(event);
    if (payload?.source !== 'media') return;
    commands.beginHistoryGesture();
    try {
    const placements = mediaAssetIds(payload).flatMap((assetId) => {
      const asset = state.assets?.find((candidate) => candidate.id === assetId);
      const kind = asset && mediaAssetTrackKind(asset);
      if (!asset || !kind) return [];
      return [{ asset, kind, range: resolveMediaSourceRange(asset, mediaSourceRangeFor(payload, assetId)) }];
    });
    const ends = new Map<TrackKind, number>();
    const ids: string[] = [];
    for (const { asset, kind, range } of placements) {
      const startFrame = ends.get(kind) ?? frame;
      ids.push(commands.addMediaItem(asset, { track: destination(kind), startFrame,
        ...range, volume: mediaPlacementVolume(asset.kind, payload.purpose) }));
      ends.set(kind, startFrame + (range?.durationInFrames ?? asset.durationInFrames));
    }
    if (ids.length) commands.selectItems(ids);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('素材选段无法加入，请重新设置入点和出点。'));
    } finally { commands.endHistoryGesture(); }
  };
  const highlighted = (top && activePlacement === 'top') || (!top && activePlacement === 'bottom');
  const dropZone = <div className={`cc-new-track-drop${top ? ' is-top' : ''}${highlighted ? ' drag-over' : ''}`} data-new-track-zone={top ? 'top' : 'bottom'} role="group" aria-label={t(top ? '拖到这里，自动在上方新增轨道' : '拖入视频、图片或音频，自动创建轨道')} onDragOver={(event) => {
    if (!accepts(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; event.currentTarget.classList.add('drag-over');
  }} onDragLeave={(event) => event.currentTarget.classList.remove('drag-over')} onDrop={drop}>
    {highlighted && labelOverride ? labelOverride : top ? t('拖到上方，自动新增叠加轨道') : t('拖到下方，自动新增轨道')}
  </div>;
  return (
    <div className={`cc-new-track-row${top ? ' is-top' : ''}`}>
      <div className="cc-new-track-head" style={{ width: HEADER_W }} aria-hidden />
      {dropZone}
    </div>
  );
}
