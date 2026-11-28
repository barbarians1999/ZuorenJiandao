import { policyForTool } from '../../src/agent/execution-policy.ts';
import {
  isExternalServerDirectCall,
  isExternalServerDirectTool,
} from '../../src/agent/external-tool-policy.ts';
import { ExternalEditorCallError } from './broker.ts';

const OFFLINE_PERSISTENT_LOCAL_TOOLS = new Set([
  'import_media',
  'finalize_uploaded_asset',
  'import_asset',
  'import_assets',
  'import_folder',
]);

export function assertOfflineToolAllowed(
  name: string,
  args: Record<string, unknown>,
  editorUrl: string,
): void {
  if (!isExternalServerDirectTool(name)) {
    throw new ExternalEditorCallError(
      'rejected',
      `Tool ${name} requires the browser editor. Open ${editorUrl} for visual/canvas inspection, generation, network, preset, render, or export tools.`,
    );
  }
  if (!isExternalServerDirectCall(name, args)) {
    const detail = name === 'edit_item'
      ? `Tool ${name} includes browser-only effect/transition/library operations. Open ${editorUrl} to run them.`
      : `Tool ${name} action ${String(args.action ?? '')} uses browser-backed data. Open ${editorUrl} to run it.`;
    throw new ExternalEditorCallError('rejected', detail);
  }
  const policy = policyForTool(name, args);
  const allowedEffect = policy.effect === 'read'
    || policy.effect === 'reversible_edit'
    || (policy.effect === 'persistent_local' && OFFLINE_PERSISTENT_LOCAL_TOOLS.has(name));
  if (!allowedEffect) {
    throw new ExternalEditorCallError(
      'rejected',
      `Tool ${name} is not permitted by the offline execution policy.`,
    );
  }
}
