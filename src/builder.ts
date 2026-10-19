/**
 * The template builder: the granular tools the PDF Generator API editor uses to build a template
 * (add, patch, move and remove components, pages and table rows; read the structure; validate),
 * run on the client's own model. Three tools reach it, so a client loads the builder's catalogue
 * only when it builds a template.
 */
import type { McpToolDefinition } from './types.js';
import { BUILDER_BASE_URL } from './config.js';

export const GET_BUILDER_GUIDE = 'get_builder_guide';
export const LIST_BUILDER_TOOLS = 'list_builder_tools';
export const RUN_BUILDER_TOOL = 'run_builder_tool';

/**
 * The builder tools that only read. Any other one changes the template and needs write access,
 * so a tool the builder adds later is treated as a write until it is listed here.
 */
const READ_ONLY_BUILDER_TOOLS = new Set([
  'get_template_structure',
  'show_component',
  'list_pages',
  'list_components',
  'list_children',
  'list_table_rows',
  'validate_template',
]);

export function builderToolChangesTemplate(tool: unknown): boolean {
  return !(typeof tool === 'string' && READ_ONLY_BUILDER_TOOLS.has(tool));
}

export const builderToolDefinitionMap: Map<string, McpToolDefinition> = new Map([
  [GET_BUILDER_GUIDE, {
    name: GET_BUILDER_GUIDE,
    description: `Returns the template builder guide: how to build or change a template step by step with ${RUN_BUILDER_TOOL}, the layout rules, and the reference of every component type. Read it once before building a template or changing its layout.`,
    inputSchema: { type: 'object', properties: {} },
    method: 'get',
    pathTemplate: '/guide',
    executionParameters: [],
    requestBodyContentType: undefined,
    baseUrl: BUILDER_BASE_URL,
  }],
  [LIST_BUILDER_TOOLS, {
    name: LIST_BUILDER_TOOLS,
    description: `Lists the template builder tools ${RUN_BUILDER_TOOL} can run, each with its description, its JSON input schema and whether it changes the template.`,
    inputSchema: { type: 'object', properties: {} },
    method: 'get',
    pathTemplate: '/tools',
    executionParameters: [],
    requestBodyContentType: undefined,
    baseUrl: BUILDER_BASE_URL,
  }],
  [RUN_BUILDER_TOOL, {
    name: RUN_BUILDER_TOOL,
    description: `Runs one template builder tool on a template: read its structure, add, patch, move or remove components, pages, table rows and columns, or validate it. Take the tool name and its arguments from ${LIST_BUILDER_TOOLS}, and follow ${GET_BUILDER_GUIDE}. Every change is saved at once and creates a template version.`,
    inputSchema: {
      type: 'object',
      properties: {
        template_id: { type: 'integer', description: 'ID of the template to work on.' },
        tool: { type: 'string', description: `Name of the builder tool, from ${LIST_BUILDER_TOOLS}.` },
        requestBody: {
          type: 'object',
          properties: {
            arguments: { type: 'object', description: 'Arguments for the builder tool, matching its input schema.' },
            data: {
              type: 'object',
              description: 'Sample data for the template\'s placeholders. Send it with validate_template so it can report placeholders with nothing behind them.',
            },
          },
          description: 'The builder tool\'s arguments, and optionally the sample data.',
        },
      },
      required: ['template_id', 'tool'],
    },
    method: 'post',
    pathTemplate: '/templates/{template_id}/tools/{tool}',
    executionParameters: [{ name: 'template_id', in: 'path' }, { name: 'tool', in: 'path' }],
    requestBodyContentType: 'application/json',
    baseUrl: BUILDER_BASE_URL,
  }],
]);
