import { createContext, useContext, useMemo, type CSSProperties } from 'react';
import {
  Audio as BrowserAudio,
  type AudioProps as BrowserAudioProps,
} from '@remotion/media';
import { AbsoluteFill, Audio as ServerAudio, Html5Audio, Img, Sequence, getRemotionEnvironment, useCurrentFrame } from 'remotion';
import { ClipFx } from '../gl/ClipFx';
import { firstGlEffect } from '../gl/clipEffects';
import { selectEffectPreviewAdapter, type SelectedPreviewStatusListener } from '../gl/previewAdapter';
import { voiceIsolationMix } from '../audio/voiceMix';
import { backgroundFillAppearanceFor, backgroundFillFilter } from './backgroundFill';
import { appearanceAt } from './clipFade';
import { zoomAt } from './zoom';
import { clipFadeFactor, clipOpacityAt } from './clipFade';
import { volumeAtFrame } from './keyframes';
import { sourceFrameAt } from './sourceLimit';
import { audioCrossfadeAutomation } from './audioCrossfade';
import type { AspectFit, MediaAsset, TimelineItem, TransitionItem } from './types';
import { clampVisualBorderRadius, objectFitInsideVisualFrame, visibleVisualFrameRect } from './visualFrameGeometry';
import { ClipMaskSurface } from './ClipMaskSurface';
import { sharedVisualFrame, sharedAudioVolume } from './transitionAudio';
import { pictureAnimationAt } from './clipAnimation';
import { RuntimeVideo, usesSeparatePlainMediaAudio } from './RuntimeVideo';
import { SyncedGif } from './SyncedGif';
import { hasPotentialClipAudio } from '../../shared/timeline-media-schedule.mjs';
import { isPreviewSourceSilent, usePreviewSourceSilent } from '../media/previewMedia';
import { hasPrivacyMosaic } from './mosaic';
import { usesVideoAudioRenderer } from './videoAudioRouting';
import { audioPlaybackWindows, selectActivePlayerAudioWindows } from './audioPlaybackWindow';
import { usePreviewPlaybackRate } from './PreviewPlaybackContext';
import { attachNativeMediaElementGuard, nativeAcceptableTimeShiftSeconds } from '../media/nativePlaybackGuard';

export function shouldMountPlayerSeparateAudio(
  item: Pick<TimelineItem, 'src' | 'denoisedSrc' | 'audioDetached' | 'volume' | 'keyframes'> & { kind?: TimelineItem['kind'] },
  groupedAudio: boolean,
  muted: boolean,
  isPlayer: boolean,
): boolean {
  if (groupedAudio || muted) return false;
  if (!isPlayer) return true;
  if (item.audioDetached) return false;
  if (!hasPotentialClipAudio({ ...item, kind: item.kind ?? 'video' })) return false;
  if (!item.denoisedSrc && isPreviewSourceSilent(item.src)) return false;
  return true;
}

const EMPTY_MEDIA_ASSETS: MediaAsset[] = [];
export const PreviewAudioEnabled = createContext(true);

function RuntimeAudio({ browserRenderer, videoAudio = false, ...props }: BrowserAudioProps & {
  browserRenderer: boolean;
  videoAudio?: boolean;
}) {
  const globalPlaybackRate = usePreviewPlaybackRate();
  if (getRemotionEnvironment().isPlayer) {
    // Html5Audio combines the clip rate with the Player's global JKL rate itself.
    return (
      <Html5Audio
        {...props}
        ref={attachNativeMediaElementGuard}
        acceptableTimeShiftInSeconds={nativeAcceptableTimeShiftSeconds(props.playbackRate, globalPlaybackRate)}
        preservePitch
      />
    );
  }
  return browserRenderer || videoAudio
    ? <BrowserAudio {...props} />
    : <ServerAudio {...props} preservePitch />;
}

function MixedRuntimeAudio({ item, browserRenderer, videoAudio, volume, ...props }: Omit<BrowserAudioProps, 'src'> & {
  item: TimelineItem;
  browserRenderer: boolean;
  videoAudio?: boolean;
}) {
  if (!useContext(PreviewAudioEnabled)) return null;
  const useVideoAudio = videoAudio ?? usesVideoAudioRenderer(item);
  if (!item.denoisedSrc) {
    return <RuntimeAudio browserRenderer={browserRenderer} videoAudio={useVideoAudio} {...props} src={item.src!} volume={volume} />;
  }
  const mix = voiceIsolationMix(item.denoiseStrength);
  const scaledVolume = (gain: number): BrowserAudioProps['volume'] => (
    typeof volume === 'function' ? (frame) => volume(frame) * gain : (volume ?? 1) * gain
  );
  return (
    <>
      {mix.dry > 0 && <RuntimeAudio browserRenderer={browserRenderer} videoAudio={useVideoAudio} {...props} src={item.src!} volume={scaledVolume(mix.dry)} />}
      {mix.wet > 0 && <RuntimeAudio browserRenderer={browserRenderer} videoAudio={useVideoAudio} {...props} src={item.denoisedSrc} volume={scaledVolume(mix.wet)} />}
    </>
  );
}

export function VisualClipSurface({ item, fit, canvasW, canvasH, borderRadius, children }: {
  item: TimelineItem;
  fit: AspectFit;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
  children: React.ReactNode;
}) {
  const sourceWidth = item.kind === 'solid' ? canvasW : item.width ?? canvasW;
  const sourceHeight = item.kind === 'solid' ? canvasH : item.height ?? canvasH;
  const frame = item.kind === 'solid'
    ? { x: 0, y: 0, width: canvasW, height: canvasH }
    : visibleVisualFrameRect(
      { width: canvasW, height: canvasH },
      { width: sourceWidth, height: sourceHeight },
      fit,
    );
  const resolvedRadius = clampVisualBorderRadius(borderRadius, frame);
  return (
    <AbsoluteFill>
      <div style={{
        position: 'absolute',
        left: frame.x,
        top: frame.y,
        width: frame.width,
        height: frame.height,
        overflow: resolvedRadius ? 'hidden' : undefined,
        borderRadius: resolvedRadius ? `${resolvedRadius}px` : undefined,
      }}>
        {children}
      </div>
    </AbsoluteFill>
  );
}

export function AudioClip({ item, fps: _fps, muted, gainAt, timelineItems, assets = EMPTY_MEDIA_ASSETS, transitions, premountFor, browserRenderer }: {
  item: TimelineItem;
  fps: number;
  muted: boolean;
  gainAt: (frame: number) => number;
  timelineItems: TimelineItem[];
  assets?: MediaAsset[];
  transitions?: TransitionItem[];
  premountFor: number;
  browserRenderer: boolean;
}) {
  const volumeAt = (localFrame: number) => (muted ? 0 : volumeAtFrame(item, localFrame));
  const crossfade = useMemo(
    () => audioCrossfadeAutomation(item, timelineItems, transitions, assets),
    [item, timelineItems, transitions, assets],
  );
  if (!item.src) return null;
  const extensions = crossfade.extensions;
  const frameGainAt = (localFrame: number): number => crossfade.gainAt(item.startFrame + localFrame);
  return (
    <Sequence from={item.startFrame - extensions.beforeFrames}
      durationInFrames={item.durationInFrames + extensions.beforeFrames + extensions.afterFrames}
      premountFor={premountFor} name={item.name}>
      <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} videoAudio={usesVideoAudioRenderer(item, timelineItems)}
        trimBefore={sourceFrameAt(item, -extensions.beforeFrames)} playbackRate={item.playbackRate ?? 1}
        volume={(frame) => {
          const localFrame = frame - extensions.beforeFrames;
          return volumeAt(localFrame) * gainAt(item.startFrame + localFrame)
            * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames)
            * frameGainAt(localFrame);
        }} />
    </Sequence>
  );
}

export function PlayerAudioLayers({ items, timelineItems, assets = EMPTY_MEDIA_ASSETS, transitions, fps, premountFor, browserRenderer, isMuted, gainAt }: {
  items: TimelineItem[]; timelineItems: TimelineItem[]; assets?: MediaAsset[]; transitions?: TransitionItem[];
  fps: number; premountFor: number; browserRenderer: boolean;
  isMuted: (track: TimelineItem['track']) => boolean;
  gainAt: (track: TimelineItem['track'], frame: number) => number;
}) {
  const frame = useCurrentFrame();
  const windows = useMemo(() => audioPlaybackWindows(items, timelineItems, assets, transitions, fps, premountFor),
    [items, timelineItems, assets, transitions, fps, premountFor]);
  return <>{selectActivePlayerAudioWindows(windows, frame).map(({ item }) => (
    <AudioClip key={item.id} item={item} fps={fps} muted={isMuted(item.track)} gainAt={(at) => gainAt(item.track, at)}
      timelineItems={timelineItems} assets={assets} transitions={transitions} premountFor={premountFor} browserRenderer={browserRenderer} />
  ))}</>;
}

export function ContinuousVideoAudio({ items, muted, gainAt, premountFor, browserRenderer }: {
  items: TimelineItem[];
  muted: boolean;
  gainAt: (track: TimelineItem['track'], frame: number) => number;
  premountFor: number;
  browserRenderer: boolean;
}) {
  const volume = useMemo(() => sharedAudioVolume(items, muted, gainAt), [items, muted, gainAt]);
  const first = items[0];
  const last = items.at(-1);
  const firstSilent = usePreviewSourceSilent(first?.src);
  if (!first || !last || (getRemotionEnvironment().isPlayer && (volume === 0 || (!first.denoisedSrc && firstSilent)))) return null;
  const duration = last.startFrame + last.durationInFrames - first.startFrame;
  return (
    <Sequence from={first.startFrame} durationInFrames={duration} premountFor={premountFor} name={`${first.name}:audio`}>
      <MixedRuntimeAudio item={first} browserRenderer={browserRenderer} trimBefore={first.srcInFrame ?? 0}
        playbackRate={first.playbackRate ?? 1} volume={volume} />
    </Sequence>
  );
}

export function PlayerContinuousVideoAudioLayers({ groups, isMuted, gainAt, premountFor, browserRenderer }: {
  groups: TimelineItem[][];
  isMuted: (track: TimelineItem['track']) => boolean;
  gainAt: (track: TimelineItem['track'], frame: number) => number;
  premountFor: number;
  browserRenderer: boolean;
}) {
  const frame = useCurrentFrame();
  const windows = useMemo(() => groups.flatMap((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return [];
    return [{
      group,
      from: first.startFrame - premountFor,
      activeFrom: first.startFrame,
      to: last.startFrame + last.durationInFrames,
    }];
  }), [groups, premountFor]);
  return (
    <>
      {selectActivePlayerAudioWindows(windows, frame, 4).map(({ group }) => (
        <ContinuousVideoAudio
          key={`audio:${group[0]!.id}`}
          items={group}
          muted={isMuted(group[0]!.track)}
          gainAt={gainAt}
          premountFor={premountFor}
          browserRenderer={browserRenderer}
        />
      ))}
    </>
  );
}

export function SharedVideoVisualGroup({ group, fit, canvasW, canvasH, premountFor, postmountFor, browserRenderer }: {
  group: TimelineItem[];
  fit: AspectFit;
  muted: boolean;
  canvasW: number;
  canvasH: number;
  premountFor: number;
  postmountFor: number;
  browserRenderer: boolean;
}) {
  const frame = useCurrentFrame();
  const first = group[0];
  const last = group.at(-1);
  if (!first || !last || !first.src) return null;
  const duration = last.startFrame + last.durationInFrames - first.startFrame;
  const { item, localFrame } = sharedVisualFrame(group, frame)!;
  const clampedLocalFrame = Math.max(0, Math.min(Math.max(0, item.durationInFrames - 1), localFrame));
  const appearance = appearanceAt(item, clampedLocalFrame, item.pictureDisabled === true, { width: canvasW, height: canvasH });
  const sourceWidth = item.width ?? canvasW;
  const sourceHeight = item.height ?? canvasH;
  const rect = visibleVisualFrameRect(
    { width: canvasW, height: canvasH },
    { width: sourceWidth, height: sourceHeight },
    fit,
  );
  const resolvedRadius = clampVisualBorderRadius(appearance.borderRadius, rect);
  const style: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: objectFitInsideVisualFrame(fit),
  };
  let visual = (
    <RuntimeVideo browserRenderer={browserRenderer} src={first.src} trimBefore={first.srcInFrame ?? 0}
      playbackRate={first.playbackRate ?? 1} volume={0} muted style={style} />
  );
  if (item.zoom) {
    const zoom = zoomAt(item.zoom, clampedLocalFrame, item.durationInFrames);
    visual = (
      <AbsoluteFill style={{ transform: `scale(${zoom.magnification})`, transformOrigin: `${zoom.focalX * 100}% ${zoom.focalY * 100}%` }}>
        {visual}
      </AbsoluteFill>
    );
  }
  const isPlayer = getRemotionEnvironment().isPlayer;
  return (
    <Sequence from={first.startFrame} durationInFrames={duration} premountFor={premountFor} postmountFor={postmountFor}
      styleWhilePremounted={isPlayer ? { opacity: 0 } : undefined}
      styleWhilePostmounted={isPlayer ? { opacity: 0, pointerEvents: 'none' } : undefined}
      name={`${first.name}:visual`}>
      <AbsoluteFill style={{
        opacity: appearance.opacity,
        transform: appearance.foregroundStyle.transform,
        transformOrigin: appearance.foregroundStyle.transformOrigin,
        transformBox: appearance.foregroundStyle.transformBox,
        filter: appearance.foregroundStyle.filter,
        clipPath: appearance.foregroundStyle.clipPath,
      }}>
        <AbsoluteFill style={{ clipPath: appearance.maskClipPath }}>
          <ClipMaskSurface mask={appearance.mask} width={canvasW} height={canvasH}>
            <div style={{
              position: 'absolute',
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              overflow: resolvedRadius ? 'hidden' : undefined,
              borderRadius: resolvedRadius,
            }}>
              {visual}
            </div>
          </ClipMaskSurface>
        </AbsoluteFill>
      </AbsoluteFill>
    </Sequence>
  );
}

export function BackgroundFillLayer({ item, frameOffset, canvasW, canvasH, browserRenderer, exactEffects = true }: {
  item: TimelineItem;
  frameOffset: number;
  canvasW: number;
  canvasH: number;
  browserRenderer: boolean;
  exactEffects?: boolean;
}) {
  const appearance = backgroundFillAppearanceFor(item, canvasW, canvasH);
  const opacity = clipOpacityAt(item, useCurrentFrame() + frameOffset);
  const motion = pictureAnimationAt(item, useCurrentFrame() + frameOffset);
  const trimBefore = sourceFrameAt(item, frameOffset);
  const filters = item.filters;
  const style: CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    transform: `scale(${appearance.overscanScale})`,
    filter: backgroundFillFilter(appearance, filters),
  };
  const effect = (exactEffects || hasPrivacyMosaic(item)) && firstGlEffect(item);
  if (hasPrivacyMosaic(item) && !effect) {
    if (getRemotionEnvironment().isRendering) throw new Error('Mosaic background unavailable; refusing an unredacted export');
    return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  }
  return (
    <AbsoluteFill aria-hidden style={{ opacity, transform: motion.transform || undefined, filter: motion.blur ? `blur(${motion.blur}px)` : undefined, overflow: 'hidden', pointerEvents: 'none' }}>
      {effect
        ? <AbsoluteFill style={style}>
            <ClipFx item={item} fit="cover" width={canvasW} height={canvasH} frameOffset={frameOffset} />
          </AbsoluteFill>
        : item.kind === 'image' || item.kind === 'svg'
          ? <Img src={item.src!} style={style} />
          : item.kind === 'gif'
            ? <SyncedGif src={item.src!} item={item} frameOffset={frameOffset} style={style} />
            : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
                playbackRate={item.playbackRate ?? 1} volume={0} muted style={style} />}
    </AbsoluteFill>
  );
}

interface MediaFillProps {
  item: TimelineItem;
  frameOffset: number;
  fit: AspectFit;
  muted: boolean;
  groupedAudio: boolean;
  audioWindowActive?: boolean;
  canvasW: number;
  canvasH: number;
  borderRadius: number;
  gainAt: (frame: number) => number;
  browserRenderer: boolean;
  onPreviewStatus?: SelectedPreviewStatusListener;
  exactEffects?: boolean;
}

type MediaVolume = (frame: number) => number;

function EffectMediaFill({ props, trimBefore, volume }: {
  props: MediaFillProps;
  trimBefore: number;
  volume: MediaVolume;
}) {
  const { item, fit, canvasW, canvasH, borderRadius, frameOffset, onPreviewStatus, groupedAudio, browserRenderer, muted } = props;
  usePreviewSourceSilent(item.src);
  const frame = visibleVisualFrameRect(
    { width: canvasW, height: canvasH },
    { width: item.width ?? canvasW, height: item.height ?? canvasH },
    fit,
  );
  const mountSeparateAudio = item.kind !== 'image' && shouldMountPlayerSeparateAudio(item, groupedAudio, muted, getRemotionEnvironment().isPlayer) && props.audioWindowActive !== false;
  return (
    <>
      <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
        <ClipFx item={item} fit={fit === 'contain' ? 'cover' : fit} width={Math.max(1, Math.round(frame.width))}
          height={Math.max(1, Math.round(frame.height))} frameOffset={frameOffset} onPreviewStatus={onPreviewStatus} />
      </VisualClipSurface>
      {mountSeparateAudio && <MixedRuntimeAudio item={item} browserRenderer={browserRenderer}
        trimBefore={trimBefore} playbackRate={item.playbackRate ?? 1} volume={volume} />}
    </>
  );
}

function PlainMediaFill({ props, trimBefore, volume }: {
  props: MediaFillProps;
  trimBefore: number;
  volume: MediaVolume;
}) {
  const { item, fit, canvasW, canvasH, borderRadius, groupedAudio, browserRenderer, muted } = props;
  usePreviewSourceSilent(item.src);
  const style: CSSProperties = { width: '100%', height: '100%', objectFit: objectFitInsideVisualFrame(fit) };
  const still = item.kind === 'image' || item.kind === 'svg';
  const isPlayer = getRemotionEnvironment().isPlayer;
  // `@remotion/media` <Video> in Player sets HTMLMediaElement.playbackRate without preservesPitch;
  // route live Player preview audio via MixedRuntimeAudio -> <Html5Audio preservePitch>.
  const separateAudio = item.kind !== 'gif' && usesSeparatePlainMediaAudio(item.kind, item.denoisedSrc, isPlayer);
  const mountSeparateAudio = shouldMountPlayerSeparateAudio(item, groupedAudio, muted, isPlayer) && props.audioWindowActive !== false;
  return (
    <VisualClipSurface item={item} fit={fit} canvasW={canvasW} canvasH={canvasH} borderRadius={borderRadius}>
      {still
        ? <Img src={item.src!} style={style} />
        : item.kind === 'gif'
          ? <SyncedGif src={item.src!} item={item} frameOffset={props.frameOffset} style={style} />
          : separateAudio
          ? <><RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={0} muted style={style} />
            {mountSeparateAudio && <MixedRuntimeAudio item={item} browserRenderer={browserRenderer} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={volume} />}</>
          : <RuntimeVideo browserRenderer={browserRenderer} src={item.src!} trimBefore={trimBefore}
              playbackRate={item.playbackRate ?? 1} volume={groupedAudio ? 0 : volume}
              muted={groupedAudio || muted} style={style} />}
    </VisualClipSurface>
  );
}

export function MediaFill(props: MediaFillProps) {
  const { item, frameOffset, muted, groupedAudio, gainAt } = props;
  const trimBefore = sourceFrameAt(item, frameOffset);
  const volume = (frame: number) => {
    const localFrame = frame + frameOffset;
    if (localFrame < 0 || localFrame >= item.durationInFrames) return 0;
    return (muted ? 0 : volumeAtFrame(item, localFrame)) * gainAt(item.startFrame + localFrame)
      * clipFadeFactor(localFrame, item.durationInFrames, item.fadeInFrames, item.fadeOutFrames);
  };
  const adapter = selectEffectPreviewAdapter({
    declared: !!firstGlEffect(item),
    texturable: item.kind === 'video' || item.kind === 'image',
  });
  if (hasPrivacyMosaic(item) && adapter.adapter !== 'gl-effect') {
    if (getRemotionEnvironment().isRendering) throw new Error('Mosaic is unavailable for this media type; refusing an unredacted export');
    return <AbsoluteFill style={{ backgroundColor: '#000', color: '#fff', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>马赛克暂不可用，已隐藏画面</AbsoluteFill>;
  }
  return (props.exactEffects !== false || hasPrivacyMosaic(item)) && adapter.adapter === 'gl-effect'
    ? <EffectMediaFill props={props} trimBefore={trimBefore} volume={volume} />
    : <PlainMediaFill props={{ ...props, groupedAudio }} trimBefore={trimBefore} volume={volume} />;
}
