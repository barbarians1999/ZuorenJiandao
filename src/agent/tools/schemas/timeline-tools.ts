import type { AgentToolSchema } from '../../tool-schema';

export const TIMELINE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_timelines',
    description:
      'Manage project timelines (sequences): list/create/duplicate/switch/update/delete, insert one timeline as a nested sequence instance in the active timeline, or pack_compound / unpack_compound (group clips into an editable compound clip or expand one level back to tracks). Nested instances reference the child timeline without copying it and reject missing/cyclic references.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'duplicate', 'switch', 'update', 'delete', 'insert', 'pack_compound', 'unpack_compound'], description: 'What to do.' },
        timelineId: { type: 'string', description: 'Target timeline id (prefix/name ok). insert: the child timeline to reference; update defaults to active.' },
        timelineIds: { type: 'array', items: { type: 'string' }, description: 'delete: several timeline ids (prefixes ok).' },
        name: { type: 'string', description: 'create/duplicate: the new timeline\'s name; update: rename; pack_compound: optional compound clip name.' },
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'Canvas aspect preset (create/update). Use ratio OR explicit width+height, not both.' },
        width: { type: 'integer', description: 'Explicit canvas width px (create/update, omit when ratio is given).' },
        height: { type: 'integer', description: 'Explicit canvas height px (create/update, omit when ratio is given).' },
        fit: { type: 'string', enum: ['contain', 'cover'], description: 'update: how existing clips adapt to the new canvas — contain letterboxes, cover fills+crops.' },
        hidden: { type: 'boolean', description: 'update: hide (true) or restore (false) the timeline tab; data is kept. The last visible timeline cannot be hidden.' },
        activate: { type: 'boolean', description: 'create/duplicate: false keeps the current timeline active (default true; batch create activates the last entry).' },
        timelines: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, ratio: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } } }, description: 'create: several timelines at once, each {name, ratio | width+height}.' },
        track: { type: 'string', description: 'insert: destination video track id/alias.' },
        startFrame: { type: 'integer', description: 'insert: instance start on the active timeline.' },
        sourceStartFrame: { type: 'integer', description: 'insert: child timeline source-window in-point (default 0).' },
        sourceDurationInFrames: { type: 'integer', description: 'insert: source-window length in child timeline frames (default remaining child duration).' },
        playbackRate: { type: 'number', description: 'insert: instance speed from 0.1 to 8 (default 1).' },
        itemIds: { type: 'array', items: { type: 'string' }, description: 'pack_compound: timeline item IDs in the active timeline to pack into one compound clip (nested sequence).' },
        itemId: { type: 'string', description: 'unpack_compound: sequence item ID on the active timeline to expand one level back to its component clips (or "selected").' },
      },
      required: ['action'],
    },
  },
];

export const TIMELINE_TOOL_NAMES = new Set(TIMELINE_TOOL_SCHEMAS.map((t) => t.name));
