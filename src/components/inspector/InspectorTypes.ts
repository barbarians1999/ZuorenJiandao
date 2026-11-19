import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { Tpl } from '../../types';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import type { SlipPlan, SlipResult } from '../../editor/slip';
import type {
  ClipEffect,
  AspectFit,
  ClipFilters,
  ClipMask,
  ClipTransform,
  KeyframeEasing,
  KeyframeProp,
  TimelineItem,
  TransitionItem,
  TransitionType,
  ZoomEffect,
} from '../../editor/types';
import type { FlexCropEdge } from '../../editor/flexCrop';
import type { SelectedCaptionInspector } from '../../captions/captionSelection';
import type { CaptionsData } from '../../captions/types';
import type { AnimationAuditionPreview } from './useAnimationAudition';
import type { TrackFlags, TrackUpdate } from '../../editor/trackTypes';
import type { InspectorTab } from './InspectorContent';
import type { CompositionMosaic } from '../../editor/compositionMosaic';

export interface FadePatch {
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

export interface AutoGradeControlProps {
  busy: boolean;
  targetCount: number;
  previewCount: number;
  failedCount: number;
  selectedPreview: {
    filters: Required<Pick<ClipFilters, 'brightness' | 'contrast' | 'saturate'>>;
    bitDepth: number;
    hdr: boolean;
  } | null;
  onAnalyze: () => void | Promise<void>;
  onApply: () => void;
  onCancel: () => void;
}

export interface InspectorPanelProps {
  activeTab?: InspectorTab;
  onActiveTabChange?: (tab: InspectorTab) => void;
  templates: Tpl[];
  selectedItem: TimelineItem | null;
  selectedCaption?: SelectedCaptionInspector | null;
  onCaptionUpdate?: (patch: Partial<CaptionsData>) => void;
  selectedIds: readonly string[];
  selectedItems: readonly TimelineItem[];
  fps: number;
  canvasWidth: number;
  canvasHeight: number;
  fit?: AspectFit;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onItemPropChange: (key: string, value: unknown) => void;
  onItemVolumeChange: (volume: number) => void;
  onItemFadeChange: (fade: FadePatch) => void;
  onItemTransformChange: (patch: ClipTransform) => void;
  onItemCropChange: (edge: FlexCropEdge, value: number) => void;
  onItemFiltersChange: (patch: ClipFilters) => void;
  onItemMaskChange: (mask: ClipMask | null) => void;
  backgroundFillAvailable?: boolean;
  onItemBackgroundFillChange?: (enabled: boolean, strength?: number) => void;
  onApplyBackgroundFillToAll?: (strength: number) => void;
  autoGrade?: AutoGradeControlProps;
  onItemZoomChange: (patch: Partial<ZoomEffect> | null) => void;
  onItemEffectsChange: (effects: ClipEffect[]) => void;
  onCompositionMosaicChange?: (patch: Partial<CompositionMosaic>) => void;
  selectedPreviewStatuses?: readonly SelectedPreviewStatus[];
  onItemSpeedChange?: (rate: number) => void;
  slipPlan?: SlipPlan | null;
  onItemSlip?: (deltaInFrames: number) => SlipResult;
  onNormalizeLoudness?: () => void | Promise<void>;
  audioTracks?: readonly { id: string; label: string; config: TrackFlags }[];
  onAudioTrackChange?: (id: string, patch: TrackUpdate) => void;
  animationPreview?: AnimationAuditionPreview;
  onIsolateVoice?: (action: 'apply' | 'clear', strength?: number) => void | Promise<void>;
  getPlayhead: () => number;
  onSetReframeKeyframe: (frame: number, focalPointX: number, focalPointY: number, magnification: number) => void;
  onRemoveReframeKeyframe: (frame: number) => void;
  onSetItemKeyframe: (prop: KeyframeProp, frame: number, value: number, easing?: KeyframeEasing) => void;
  onRemoveItemKeyframe: (prop: KeyframeProp, frame: number) => void;
  onResetItemKeyframes: (props: readonly KeyframeProp[]) => void;
  onSeek: (frame: number) => void;
  transition: TransitionItem | null;
  onAddTransition: (type: TransitionType) => void;
  onSetTransition: (patch: Partial<TransitionItem>) => void;
  onRemoveTransition: () => void;
  playerRef: RefObject<PlayerRef | null>;
  historyGesture: { begin: () => void; end: () => void };
}
