import type { MediaAsset, MediaAssetRelinkPatch } from '../editor/types';
import type { MobileUploadRecord } from './mobileUploadApi';
import type { MediaSourceRange, MediaSourceRanges } from '../editor/mediaSourceRange';

/** Shared ingest callbacks; the pool's view/watch state stays in its own panel. */
export interface MediaPoolIngestProps {
  onAssetLoadError: (asset: MediaAsset) => void;
  onImport: (
    file: File,
    onProgress?: (ratio: number) => void,
    lifecycle?: {
      onPlaceholder?: (asset: MediaAsset) => void;
      onAssetUpdated?: (asset: MediaAsset) => void;
      onFailure?: (asset: MediaAsset | null, error: unknown) => void;
    },
  ) => Promise<MediaAsset>;
  onImportMobile: (record: MobileUploadRecord) => Promise<void>;
  onAddAsset: (asset: MediaAsset, sourceRange?: MediaSourceRange) => void;
  onAddAssetsToTimeline?: (assets: MediaAsset[], sourceRanges?: MediaSourceRanges) => void;
  /** Relink File replaces an offline/missing asset and its clip srcs. */
  onRelinkAsset?: (id: string, next: MediaAssetRelinkPatch) => void;
}
