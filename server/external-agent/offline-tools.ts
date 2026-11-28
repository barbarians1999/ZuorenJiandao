import {
  EXTERNAL_SESSION_TOOLS,
  externalDraftSchemas,
  type ExternalRegisteredTool,
} from '../../src/agent/external-tool-shape.js';
import { isExternalServerDirectTool } from '../../src/agent/external-tool-policy.js';
import { AGENT_RUNTIME_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/agent-runtime-tools.js';
import { CORE_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/core-tools.js';
import { FONT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/font-tools.js';
import { FRAMES_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/frames-tool.js';
import { LIBRARY_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/library-tools.js';
import { CAPTIONS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/captions-tools.js';
import { MARKERS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/markers-tools.js';
import { READ_PROJECT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/read-project-tools.js';
import { SCRIPT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/script-tools.js';
import { TIMELINE_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/timeline-tools.js';
import { TRACK_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/track-tools.js';
import { TRANSCRIPT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/transcript-tools.js';
import { WATERMARK_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/watermark-tools.js';
import { AGENT_PATH_IMPORT_SCHEMAS } from '../../src/agent/tools/agent-path-import-tools.js';
import { EDIT_ITEM_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/edit-item-tools.js';
import { MEDIA_POOL_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/media-pool-tools.js';
import { UPLOAD_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/upload-tools.js';
import { TIMELINE_IMPORT_TOOL_SCHEMAS } from '../../src/agent/tools/timeline-import-tools.js';

const OFFLINE_TOOL_DESCRIPTIONS: Record<string, string> = {
  begin_edit_session: 'Start an offline server draft. approvalMode must be auto; open the editor URL for manual approval.',
  review_edit_session: 'Atomically commit the complete offline draft and return terminal status applied, or write nothing.',
  edit_captions: 'Edit built-in caption template, style, layout, text, manual cues (cue_add/cue_update/cue_remove), import_srt, paste_transcript, source, and language data, with optional skipAvoidance on enable/source_*. preset_* actions require the browser editor.',
  edit_item: 'Add pool media clips (video/audio/image/gif/svg/motion-graphic), authored text/solid clips (including paperPreset backgrounds and strikeAnimated/refute-strike), builtin transitions (builtin:tr-* including ink-bleed and archival-line-wipe), local explainer templates (library:motion-graphic:zuoren-explainer-*), or run generic clip updates (including sequence, cubicOut/springOut keyframes, and cutout/archivalCard image props)/deletes/slip/pool replacement offline. GL effect, custom tr:* transition, and cloud library motion-graphic/SFX operations require the browser editor.',
};

const OFFLINE_SESSION_TOOL_NAMES = new Set([
  'begin_edit_session',
  'get_edit_session',
  'review_edit_session',
  'discard_edit_session',
]);

const OFFLINE_SCHEMA_GROUPS = [
  AGENT_RUNTIME_TOOL_SCHEMAS,
  AGENT_PATH_IMPORT_SCHEMAS,
  CORE_TOOL_SCHEMAS,
  FONT_TOOL_SCHEMAS,
  FRAMES_TOOL_SCHEMAS,
  LIBRARY_TOOL_SCHEMAS,
  TIMELINE_TOOL_SCHEMAS,
  TRACK_TOOL_SCHEMAS,
  SCRIPT_TOOL_SCHEMAS,
  CAPTIONS_TOOL_SCHEMAS,
  WATERMARK_TOOL_SCHEMAS,
  MARKERS_TOOL_SCHEMAS,
  MEDIA_POOL_TOOL_SCHEMAS,
  EDIT_ITEM_TOOL_SCHEMAS,
  UPLOAD_TOOL_SCHEMAS,
  READ_PROJECT_TOOL_SCHEMAS,
  TRANSCRIPT_TOOL_SCHEMAS,
  TIMELINE_IMPORT_TOOL_SCHEMAS,
] as const;

function serverDirectSchemas(): ExternalRegisteredTool[] {
  const byName = new Map(
    OFFLINE_SCHEMA_GROUPS
      .flat()
      .filter((tool) => isExternalServerDirectTool(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  return externalDraftSchemas([...byName.values()]);
}

/** Lifecycle controls plus the reviewed, dependency-closed pure-data editor subset. */
export function offlineExternalToolSchemas(): ExternalRegisteredTool[] {
  const sessionTools = EXTERNAL_SESSION_TOOLS.filter((tool) => OFFLINE_SESSION_TOOL_NAMES.has(tool.name));
  return [...sessionTools, ...serverDirectSchemas()].map((tool) => (
    OFFLINE_TOOL_DESCRIPTIONS[tool.name]
      ? { ...tool, description: OFFLINE_TOOL_DESCRIPTIONS[tool.name] }
      : tool
  ));
}
