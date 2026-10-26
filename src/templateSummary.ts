/**
 * Short answers from the tools that save a template. The API answers each write with the whole
 * saved template, which can run to hundreds of thousands of characters: over a chat client's
 * tool-output limit, so the answer was cut or dropped. These tools answer with a summary instead,
 * and the full template on request.
 */
import type { JsonObject, McpToolDefinition } from './types.js';
import { FULL_RESPONSE_ARGUMENT } from './execute.js';

/** The tools whose response is the template they saved. */
const TEMPLATE_WRITE_TOOLS = ['create_template', 'update_template', 'copy_template', 'import_template'];

/**
 * The template definition, left out of the summary. Every other field is kept, so what the API
 * reports next to the template, such as warnings, still reaches the client.
 */
const DEFINITION_FIELDS = ['layout', 'pages', 'dataSettings', 'editor', 'backgroundPdf', 'resources'];

/** The template in a write tool's answer, without its definition but with its size. */
export function summarizeTemplateResponse(body: JsonObject): JsonObject {
  const template = body?.response;

  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    return body;
  }

  const pages = Array.isArray(template.pages) ? template.pages : [];
  const summary = Object.fromEntries(Object.entries(template).filter(([field]) => !DEFINITION_FIELDS.includes(field)));

  return {
    ...body,
    response: { ...summary, pageCount: pages.length, componentCount: countComponents(pages) },
  };
}

/** Components on the pages, counting those inside composite components, headers and footers. */
function countComponents(holders: unknown[]): number {
  return holders.reduce<number>((count, holder) => {
    const components = (holder as JsonObject)?.components;

    return Array.isArray(components) ? count + components.length + countComponents(components) : count;
  }, 0);
}

/** The template write tools, answering with a summary unless the call asks for the full response. */
export function withTemplateSummaries(tools: Map<string, McpToolDefinition>): Map<string, McpToolDefinition> {
  return new Map([...tools].map(([name, definition]) => [
    name,
    TEMPLATE_WRITE_TOOLS.includes(name) ? summarizing(definition) : definition,
  ]));
}

function summarizing(definition: McpToolDefinition): McpToolDefinition {
  return {
    ...definition,
    description: `${definition.description} Returns a summary of the saved template: its id, name and how many pages and components it has, without the template itself. Set ${FULL_RESPONSE_ARGUMENT} to true to get the whole template, or read it with get_template.`,
    inputSchema: {
      ...definition.inputSchema,
      properties: {
        ...definition.inputSchema.properties,
        [FULL_RESPONSE_ARGUMENT]: {
          type: 'boolean',
          description: 'Return the whole saved template instead of a summary. It can be too large for the client to show.',
        },
      },
    },
    summarizeResponse: summarizeTemplateResponse,
  };
}
