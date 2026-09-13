import { resolveLlmBaseUrl } from "./llm-config.ts";
import {
  llmProviderConfigNames,
  normalizeLlmProvider,
} from "../shared/llm-providers.ts";

/**
 * One-time compatibility migration plan. Old installs had a single LLM tuple
 * (LLM_API_KEY/BASE_URL/MODEL); attach it to the provider that was active when
 * those values were saved. Only migrate into a provider slot with no
 * per-provider config at all: LLM_PROVIDER changes over time, and grafting the
 * legacy base URL onto a provider the user configured later silently reroutes
 * it to the old relay.
 */
export function planLegacyLlmMigration(
  has: (name: string) => boolean,
  get: (name: string) => string,
): Array<[string, string]> {
  const legacyProvider = normalizeLlmProvider(get("LLM_PROVIDER"));
  const names = llmProviderConfigNames(legacyProvider);
  if ([names.apiKey, names.baseUrl, names.model].some(has)) return [];
  const plan: Array<[string, string]> = [];
  const push = (target: string, value: string): void => {
    if (value) plan.push([target, value]);
  };
  push(names.apiKey, get("LLM_API_KEY"));
  push(
    names.baseUrl,
    has("LLM_BASE_URL")
      ? resolveLlmBaseUrl(
          legacyProvider,
          get("LLM_BASE_URL"),
          get("LLM_BASE_URL_FORMAT"),
        )
      : "",
  );
  push(names.model, get("LLM_MODEL"));
  return plan;
}
