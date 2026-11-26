import { useEffect, useRef } from 'react';
import { Video as BrowserVideo, type VideoProps } from '@remotion/media';
import { getInputProps, Html5Video, OffthreadVideo, useRemotionEnvironment } from 'remotion';
import { isBrowserPlayableNativeAlpha, isBrowserPlayableNativeVideo, usePreviewSourceAlpha } from '../media/previewMedia';
import {
  attachNativeMediaElementGuard,
  nativeAcceptableTimeShiftSeconds,
  withOpenEndedPreviewHash,
} from '../media/nativePlaybackGuard';
import { usePreviewPlaybackRate } from './PreviewPlaybackContext';

type RuntimeVideoProps = Pick<VideoProps,
  'src' | 'trimBefore' | 'trimAfter' | 'playbackRate' | 'volume' | 'style' | 'muted'> & {
  browserRenderer: boolean;
};

export function nativeVideoRendering(browserRenderer: boolean, environment: {
  isRendering: boolean;
  isClientSideRendering: boolean;
}, opaqueSource = false): boolean {
  return environment.isRendering && !environment.isClientSideRendering && !browserRenderer && opaqueSource;
}

export function usesSeparatePlainMediaAudio(
  kind: string,
  denoisedSrc: string | null | undefined,
  isPlayer: boolean,
): boolean {
  const still = kind === 'image' || kind === 'gif' || kind === 'svg';
  return !still && (Boolean(denoisedSrc) || isPlayer);
}

export function shouldUseNativePlayerVideo(args: {
  isPlayer: boolean;
  isRendering: boolean;
  browserRenderer: boolean;
  src: string | undefined;
  isAlpha: boolean;
  clipPlaybackRate?: number;
  globalPlaybackRate?: number;
}): boolean {
  if (!args.isPlayer || args.isRendering || args.browserRenderer) return false;
  if (args.isAlpha) return isBrowserPlayableNativeAlpha(args.src);
  if (isBrowserPlayableNativeVideo(args.src)) return true;
  const clipRate = Number.isFinite(args.clipPlaybackRate) && (args.clipPlaybackRate ?? 1) > 0 ? (args.clipPlaybackRate ?? 1) : 1;
  const globalRate = Number.isFinite(args.globalPlaybackRate) && (args.globalPlaybackRate ?? 1) > 0 ? (args.globalPlaybackRate ?? 1) : 1;
  return clipRate * globalRate > 1.001;
}

/** Keep production decoding unchanged. An explicitly enabled server experiment
 * can supply opaque sources for native extraction; it is not faster in our
 * current measurements and is disabled by default. Alpha/unknown media
 * keep the existing decoder; file extensions are not used to guess transparency.
 */
export function RuntimeVideo({ browserRenderer, style, ...props }: RuntimeVideoProps) {
  const environment = useRemotionEnvironment();
  const containerRef = useRef<HTMLDivElement>(null);
  const isAlpha = usePreviewSourceAlpha(props.src);
  const globalPlaybackRate = usePreviewPlaybackRate();

  useEffect(() => {
    return () => {
      if (environment.isPlayer && containerRef.current) {
        const video = containerRef.current.querySelector('video');
        if (video) {
          try {
            video.pause();
            video.removeAttribute('src');
            video.load();
          } catch {
            // Ignore teardown errors on detached nodes
          }
        }
      }
    };
  }, [environment.isPlayer]);

  const localRender = environment.isRendering && !environment.isClientSideRendering && !browserRenderer;
  const sources = localRender ? getInputProps()._nativeOpaqueVideoSources : undefined;
  if (nativeVideoRendering(browserRenderer, environment, Array.isArray(sources) && sources.includes(props.src))) {
    return <OffthreadVideo {...props} style={style} />;
  }
  if (shouldUseNativePlayerVideo({
    isPlayer: environment.isPlayer,
    isRendering: environment.isRendering,
    browserRenderer,
    src: props.src,
    isAlpha,
    clipPlaybackRate: props.playbackRate,
    globalPlaybackRate,
  })) {
    return (
      <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'contents' }}>
        <Html5Video
          {...props}
          ref={attachNativeMediaElementGuard}
          src={withOpenEndedPreviewHash(props.src)}
          acceptableTimeShiftInSeconds={nativeAcceptableTimeShiftSeconds(props.playbackRate, globalPlaybackRate)}
          style={style}
          pauseWhenBuffering={false}
          onError={() => {
            // Native <video> error events still reach PreviewPanel's onErrorCapture for fallback.
          }}
        />
      </div>
    );
  }
  const { objectFit, ...browserStyle } = style ?? {};
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'contents' }}>
      <BrowserVideo {...props} style={browserStyle} objectFit={objectFit as VideoProps['objectFit']} />
    </div>
  );
}
