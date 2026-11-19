import type { Plugin } from 'vite';

/** Prevent legacy embedded model code from silently returning to the shipped app. */
export function editorOnlyBuildPlugin(): Plugin {
  return {
    name: 'zuoren-editor-only-contract',
    apply: 'build',
    generateBundle() {
      const forbidden = [...this.getModuleIds()].filter((raw) => {
        const id = raw.replaceAll('\\', '/');
        return /\/src\/agent\/(?:client|useAgent|model-selection|vision|systemPrompt)\.(?:ts|tsx)$/.test(id)
          || /\/src\/components\/chat\/ChatPanel/.test(id)
          || /\/src\/components\/settings\/(?:VendorPane|VendorNav|AgentPane|CodexPane|CopilotPane)/.test(id)
          || /\/src\/generate\/(?:image|video|voice|sound|music|progress)\.ts$/.test(id)
          || /\/node_modules\/(?:@ai-sdk|@anthropic-ai|@github\/copilot-sdk|@e2b)\//.test(id)
          || /\/node_modules\/ai\//.test(id);
      });
      if (forbidden.length) this.error(`Embedded AI code reached the production editor:\n${forbidden.join('\n')}`);
    },
  };
}
