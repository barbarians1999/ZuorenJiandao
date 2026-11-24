import { useSyncExternalStore } from 'react';
import { effectiveCatalog, formatShortcutKeys, subscribeKeymap } from './keymap';

export function useShortcutHint() {
  const catalog = useSyncExternalStore(subscribeKeymap, effectiveCatalog, effectiveCatalog);
  return (id: string) => {
    const keys = catalog.find((action) => action.id === id)?.keys.split(' / ')[0];
    return keys ? formatShortcutKeys(keys) : undefined;
  };
}
