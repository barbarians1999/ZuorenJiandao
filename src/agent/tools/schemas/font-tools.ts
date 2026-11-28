import type { AgentToolSchema } from '../../tool-schema';

export const FONT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'search_fonts',
    description: [
      'Search bundled, Google, user-imported, and installed local/Windows system fonts',
      '(supports Chinese family names like "思源黑体" / "方正小标宋简体", English/PostScript',
      'names like "FZXiaoBiaoSong-B05S", and aliases). Use when picking fontFamily for',
      'text clips, motion-graphic items, or captions. Any installed system/imported font',
      'name or custom fontFamily string can also be passed directly to edit_item /',
      'update_item_props / edit_captions without restriction.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to match against font family names or native-name aliases.',
        },
        projectId: {
          type: 'string',
          description: 'Ignored; the active project is used.',
        },
      },
      required: ['query'],
    },
  },
];

export const FONT_TOOL_NAMES = new Set(FONT_TOOL_SCHEMAS.map((t) => t.name));
