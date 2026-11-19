import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { MediaAsset } from '../editor/mediaTypes';
import type { FontChoice } from '../../shared/desktop-fonts';

interface FontLibraryContextValue {
  assets: readonly MediaAsset[];
  commit(choice: FontChoice, apply: () => void): void;
  canPersist: boolean;
}

const FontLibraryContext = createContext<FontLibraryContextValue>({
  assets: [], canPersist: false,
  commit: (choice, apply) => {
    if (choice.asset) throw new Error('当前界面不能保存字体资源，请在工程编辑器中选择字体');
    apply();
  },
});

export function FontLibraryProvider({ assets, onAddAsset, historyGesture, children }: {
  assets: readonly MediaAsset[];
  onAddAsset: (asset: MediaAsset) => void;
  historyGesture: { begin: () => void; end: () => void };
  children: ReactNode;
}) {
  const value = useMemo<FontLibraryContextValue>(() => ({
    assets, canPersist: true,
    commit: (choice, apply) => {
      historyGesture.begin();
      try {
        if (choice.asset && !assets.some((asset) => asset.id === choice.asset!.id)) onAddAsset(choice.asset);
        apply();
      } finally { historyGesture.end(); }
    },
  }), [assets, onAddAsset, historyGesture]);
  return <FontLibraryContext.Provider value={value}>{children}</FontLibraryContext.Provider>;
}

export const useFontLibrary = () => useContext(FontLibraryContext);
