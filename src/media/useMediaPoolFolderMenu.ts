import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AssetMenuPosition } from './useAssetMenu';

/** Folder-menu positioning and dismissal stay independent of asset operations. */
export function useMediaPoolFolderMenu(
  closeAssetMenu: () => void,
  setBlankMenuPos: Dispatch<SetStateAction<{ top: number; left: number } | null>>,
) {
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [folderMenuPos, setFolderMenuPos] = useState<AssetMenuPosition | null>(null);
  const closeFolderMenu = useCallback(() => {
    setFolderMenuId(null);
    setFolderMenuPos(null);
  }, []);
  useEffect(() => {
    if (!folderMenuId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFolderMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeFolderMenu, folderMenuId]);
  const openFolderMenu = useCallback((
    id: string,
    anchor: HTMLElement,
    point?: { x: number; y: number },
  ) => {
    closeAssetMenu();
    setBlankMenuPos(null);
    const rect = anchor.getBoundingClientRect();
    const panel = anchor.closest('.cc-media-pool')?.getBoundingClientRect();
    const menuWidth = 152;
    const anchorX = point?.x ?? rect.left;
    const anchorTop = point?.y ?? rect.top;
    const anchorBottom = point?.y ?? rect.bottom;
    const left = Math.min(
      (panel?.right ?? window.innerWidth) - menuWidth - 8,
      Math.max((panel?.left ?? 0) + 8, anchorX),
    );
    setFolderMenuId(id);
    setFolderMenuPos(anchorBottom > window.innerHeight / 2
      ? { bottom: window.innerHeight - anchorTop + 4, left }
      : { top: anchorBottom + 4, left });
  }, [closeAssetMenu, setBlankMenuPos]);
  return { folderMenuId, folderMenuPos, closeFolderMenu, openFolderMenu };
}
