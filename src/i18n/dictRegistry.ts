// The UI uses Chinese source strings directly. Only legacy catalog names need a display map.
import type { Locale } from './locale';

export interface LocaleDicts {
  readonly ui: Record<string, string>;
  readonly uiFallback: Record<string, string>;
  readonly data: Record<string, string>;
  readonly dataFallback: Record<string, string>;
}

const EMPTY: Record<string, string> = Object.freeze({});
const NONE: LocaleDicts = Object.freeze({ ui: EMPTY, uiFallback: EMPTY, data: EMPTY, dataFallback: EMPTY });
let loaded: LocaleDicts | undefined;
let inFlight: Promise<void> | null = null;

async function fetchDicts(): Promise<LocaleDicts> {
  const { ZH_DATA } = await import('./dict/zh');
  return { ui: EMPTY, uiFallback: EMPTY, data: ZH_DATA, dataFallback: EMPTY };
}

export function localeDicts(_locale: Locale): LocaleDicts {
  return loaded ?? NONE;
}

export function localeDictReady(_locale: Locale): boolean {
  return loaded !== undefined;
}

export function ensureLocaleDict(_locale: Locale): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!inFlight) {
    inFlight = fetchDicts()
      .then((dicts) => { loaded = dicts; })
      .catch(() => { inFlight = null; });
  }
  return inFlight;
}