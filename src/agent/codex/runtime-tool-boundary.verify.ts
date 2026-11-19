import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import { INITIAL } from '../../editor/initial.ts';
import { docFromTimeline } from '../../persist/projectStore.ts';
import { DEFAULT_AGENT_SETTINGS } from '../settings/agentSettings.ts';
import { TOOL_SCHEMAS } from '../tools.ts';
import { executeOpenChatCutTool } from './runtime.ts';
import { FOLLOWUP_TOOL_SCHEMAS } from '../tools/schemas/followup-tools';

const context: AgentContext = {
  commands: {} as AgentContext['commands'],
  getState: () => INITIAL,
  getDoc: () => docFromTimeline(INITIAL),
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => 'project-1',
};

const removeItemSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'remove_item');
assert.ok(removeItemSchema);
const rejectedMutation = await executeOpenChatCutTool(
  removeItemSchema,
  { itemId: 'missing' },
  {
    ctx: context,
    onEvent: () => undefined,
    settings: DEFAULT_AGENT_SETTINGS,
  },
);
assert.equal(rejectedMutation.success, false);
assert.match(JSON.stringify(rejectedMutation.result), /no item missing/);

assert(!TOOL_SCHEMAS.some((schema) => schema.name === 'ask_followup_questions'), 'embedded followup UI is retired');
const followupSchema = FOLLOWUP_TOOL_SCHEMAS.find((schema) => schema.name === 'ask_followup_questions');
assert.ok(followupSchema);
const settlementOrder: string[] = [];
const settledFollowup = await executeOpenChatCutTool(
  followupSchema,
  { fields: [{ id: 'style', label: 'Which style?', type: 'text' }] },
  {
    ctx: context,
    onEvent: (event) => {
      if (event.type === 'tool') settlementOrder.push(`tool:${event.name}`);
    },
    settings: DEFAULT_AGENT_SETTINGS,
    toolCatalog: TOOL_SCHEMAS,
    activeToolCatalog: TOOL_SCHEMAS,
    onFollowup: () => settlementOrder.push('followup'),
  },
);
assert.equal(settledFollowup.success, false);
assert.deepEqual(
  settlementOrder,
  ['tool:ask_followup_questions'],
  'retired followup must fail without displaying an embedded AI question',
);

console.log('codex runtime tool boundary verification passed');
