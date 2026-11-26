import { createContext, useContext } from 'react';

export const PreviewPlaybackRateContext = createContext(1);

export function usePreviewPlaybackRate(): number {
  return useContext(PreviewPlaybackRateContext);
}
