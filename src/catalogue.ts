/**
 * Every tool the server exposes: the API operations generated from the spec, with the template
 * writes answering in short and the lists read 10 records a page, and the template builder and the
 * page previews, which are not part of the spec.
 */
import type { McpToolDefinition } from './types.js';
import { toolDefinitionMap } from './tools.js';
import { builderToolDefinitionMap } from './builder.js';
import { previewToolDefinitionMap } from './preview.js';
import { withTemplateSummaries } from './templateSummary.js';
import { withPageSizeCap } from './pageSize.js';

export const catalogue: Map<string, McpToolDefinition> = new Map([
  ...withPageSizeCap(withTemplateSummaries(toolDefinitionMap)),
  ...builderToolDefinitionMap,
  ...previewToolDefinitionMap,
]);
