/**
 * The page size of the list operations. The API returns up to 100 records a page; through this
 * server a list is read at most 10 records at a time, so each request stays light. A call that leaves
 * the page size out gets 10 as well, not the API's 15, so its pages line up with the ones it asks for.
 */
import type { McpToolDefinition } from './types.js';

const PAGE_SIZE_ARGUMENT = 'per_page';

const MAX_PAGE_SIZE = 10;

/** The tools that take a page size, taking 1 to 10 and asking for 10 when the call leaves it out. */
export function withPageSizeCap(tools: Map<string, McpToolDefinition>): Map<string, McpToolDefinition> {
  return new Map([...tools].map(([name, definition]) => [
    name,
    definition.inputSchema?.properties?.[PAGE_SIZE_ARGUMENT] ? capped(definition) : definition,
  ]));
}

function capped(definition: McpToolDefinition): McpToolDefinition {
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...definition.inputSchema.properties,
        [PAGE_SIZE_ARGUMENT]: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PAGE_SIZE,
          default: MAX_PAGE_SIZE,
          description: `Pagination: how many records to return per page, 1 to ${MAX_PAGE_SIZE}`,
        },
      },
    },
    queryDefaults: { ...definition.queryDefaults, [PAGE_SIZE_ARGUMENT]: MAX_PAGE_SIZE },
  };
}
