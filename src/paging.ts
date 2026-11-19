/**
 * Paging of the list operations. The API returns up to 100 records a page; through this server a
 * list is read at most 50 records at a time, so each request stays light. A page is a whole number
 * from 1, so a page the API would refuse never costs a request. Left out, the page size is the
 * API's own, which is under the cap.
 */
import type { McpToolDefinition } from './types.js';

const MAX_PAGE_SIZE = 50;

/** The tools that take a page size: it takes 1 to 50, and the page a whole number from 1. */
export function withListPaging(tools: Map<string, McpToolDefinition>): Map<string, McpToolDefinition> {
  return new Map([...tools].map(([name, definition]) => [
    name,
    definition.inputSchema?.properties?.per_page ? paged(definition) : definition,
  ]));
}

function paged(definition: McpToolDefinition): McpToolDefinition {
  const { per_page: pageSize, page } = definition.inputSchema.properties;

  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...definition.inputSchema.properties,
        per_page: { ...pageSize, type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
        ...(page ? { page: { ...page, type: 'integer', minimum: 1 } } : {}),
      },
    },
  };
}
