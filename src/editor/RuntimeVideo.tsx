import { useEffect, useRef } from 'react';
import { Video as BrowserVideo, type VideoProps } from '@remotion/media';
import { getInputProps, OffthreadVideo, useRemotionEnvironment } from 'remotion';

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

/** Keep production decoding unchanged. An explicitly enabled server experiment
 * can supply opaque sources for native extraction; it is not faster in our
 * current measurements and is disabled by default. Alpha/unknown media
 * keep the existing decoder; file extensions are not used to guess transparency.
 */
export function RuntimeVideo({ browserRenderer, style, ...props }: RuntimeVideoProps) {
  const environment = useRemotionEnvironment();
  const containerRef = useRef<HTMLDivElement>(null);

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
  const { objectFit, ...browserStyle } = style ?? {};
  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'contents' }}>
      <BrowserVideo {...props} style={browserStyle} objectFit={objectFit as VideoProps['objectFit']} />
    </div>
  );
}
