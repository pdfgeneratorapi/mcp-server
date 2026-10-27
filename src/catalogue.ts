/**
 * Every tool the server exposes: the API operations generated from the spec, with the template
 * writes answering in short, and the template builder, which is not part of the spec.
 */
import type { McpToolDefinition } from './types.js';
import { toolDefinitionMap } from './tools.js';
import { builderToolDefinitionMap } from './builder.js';
import { withTemplateSummaries } from './templateSummary.js';

export const catalogue: Map<string, McpToolDefinition> = new Map([
  ...withTemplateSummaries(toolDefinitionMap),
  ...builderToolDefinitionMap,
]);
