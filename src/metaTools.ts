/**
 * The tools a client sees instead of one per operation: it searches the catalogue, describes the
 * operations it is about to run, and runs each with the tool that matches what it does, so its
 * hints tell the client whether to ask first.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { JsonObject } from './types.js';
import type { ToolAnnotations } from './annotations.js';
import { PREVIEW_TEMPLATE } from './preview.js';
import {
  CATEGORIES,
  DEFAULT_SEARCH_LIMIT,
  estimateTokens,
  MAX_SEARCH_LIMIT,
  LEVELS,
  callLevel,
  operations,
  searchOperations,
  type Operation,
  type OperationCategory,
  type OperationLevel,
} from './operations.js';
import { requiredScope, visibleTools, type ScopeEnforcement } from './auth/scopes.js';

export const SEARCH_OPERATIONS = 'search_operations';
export const DESCRIBE_OPERATION = 'describe_operation';
export const READ_OPERATION = 'read_operation';
export const CALL_OPERATION = 'call_operation';
export const DELETE_OPERATION = 'delete_operation';

export const MAX_DESCRIBED_OPERATIONS = 5;

const MAX_EXAMPLE_DEPTH = 10;

/** The API spec's example data for a template. */
const SPEC_EXAMPLE_DATA = { id: 123, name: 'John Smith', birthdate: '2000-01-01', role: 'Developer' };

/**
 * Example arguments for the operations a client most often starts from whose schemas require no
 * field of their template, so an example built from the schema would be empty. The template ID and
 * data are the API spec's examples.
 */
const EXAMPLE_ARGUMENTS: Record<string, JsonObject> = {
  generate_document: { requestBody: { template: { id: 19375, data: SPEC_EXAMPLE_DATA }, format: 'pdf' } },
  [PREVIEW_TEMPLATE]: { requestBody: { template: { id: 19375, data: SPEC_EXAMPLE_DATA }, pages: '1' } },
};

export interface MetaTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations: ToolAnnotations;
}

/** Why a run was refused before it reached the API, as telemetry records it. */
export type RunRefusal = 'invalid_arguments' | 'misplaced_arguments' | 'unknown_operation' | 'wrong_run_tool';

export type RunResolution =
  | { operation: Operation; args: JsonObject }
  | { refusal: RunRefusal; message: string };

const runInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: `ID of the operation, from ${SEARCH_OPERATIONS}.` },
    arguments: {
      type: 'object',
      description: `Every argument of the operation, as the input schema ${DESCRIBE_OPERATION} returns gives them. No argument goes beside id.`,
    },
  },
  required: ['id'],
};

/** The keys a run tool takes. */
const RUN_KEYS = Object.keys(runInputSchema.properties);

export const metaTools: Map<string, MetaTool> = new Map([
  [SEARCH_OPERATIONS, {
    name: SEARCH_OPERATIONS,
    description: `Finds the PDF Generator API operations for a task: templates and their versions, the template builder and previews, documents, workspaces, forms, PDF tools (convert HTML or a URL to PDF, watermark, encrypt, optimize, fill form fields, QR codes), e-invoices and the service status. Returns each match's ID, title, category, the tool that runs it and how many tokens describing it costs, best match first. Search in a few plain words, such as "add a watermark" or "list templates"; an empty query lists a category. Then describe the operations you will run with ${DESCRIBE_OPERATION}.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in a few words. Leave it empty to list the operations of a category.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'Search only this category.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          default: DEFAULT_SEARCH_LIMIT,
          description: 'The most operations to return.',
        },
      },
    },
    annotations: { title: 'Search Operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }],
  [DESCRIBE_OPERATION, {
    name: DESCRIBE_OPERATION,
    description: `Returns what operations take, for IDs that ${SEARCH_OPERATIONS} found: each one's description, its whole input schema, example arguments that fill every required field, and the tool that runs it. Describe only the operations you are about to run, up to ${MAX_DESCRIBED_OPERATIONS} at a time: each one costs the tokens ${SEARCH_OPERATIONS} shows.`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_DESCRIBED_OPERATIONS,
          description: `IDs of the operations, from ${SEARCH_OPERATIONS}.`,
        },
      },
      required: ['ids'],
    },
    annotations: { title: 'Describe Operations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }],
  [READ_OPERATION, {
    name: READ_OPERATION,
    description: `Runs an operation that only reads: one that lists or gets something, a schema, a preview, the service status, or a template builder tool that only reads. Give the operation's ID, and every argument it takes inside arguments, as ${DESCRIBE_OPERATION} shows them. An operation that creates or changes something runs with ${CALL_OPERATION}, and one that deletes something with ${DELETE_OPERATION}.`,
    inputSchema: runInputSchema,
    annotations: { title: 'Run a Read-Only Operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }],
  [CALL_OPERATION, {
    name: CALL_OPERATION,
    description: `Runs an operation that creates or changes something, or that generates or converts a document: create or update a template, generate a document, convert HTML to PDF, or run a template builder tool that changes the template. Give the operation's ID, and every argument it takes inside arguments, as ${DESCRIBE_OPERATION} shows them. Ask for a document as a link (output url or viewer) only when the user wants one: a link stores the document for 30 days. An operation that only reads is better run with ${READ_OPERATION}, and one that deletes something runs with ${DELETE_OPERATION}.`,
    inputSchema: runInputSchema,
    annotations: { title: 'Run an Operation', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }],
  [DELETE_OPERATION, {
    name: DELETE_OPERATION,
    description: `Runs an operation that deletes something: a template, a template version, a document, a workspace or a form. What it deletes cannot be restored, so make sure the user wants it gone. Give the operation's ID, and every argument it takes inside arguments, as ${DESCRIBE_OPERATION} shows them.`,
    inputSchema: runInputSchema,
    // Not idempotent: it runs anything below a delete too, such as generating a document
    annotations: { title: 'Run a Delete Operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }],
]);

function text(message: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
    : { content: [{ type: 'text', text: message }] };
}

function unknownOperation(id: string): string {
  return `There is no operation "${id}". Find one with ${SEARCH_OPERATIONS}.`;
}

/** What a client hears for an operation the connection's grant does not cover. */
export function notGrantedMessage(operationId: string, scope: string | null): string {
  return `This connection is not allowed to run "${operationId}". It needs the "${scope}" permission; reconnect and grant it.`;
}

/** The tools a client with an up-to-date tool list has, as tools/list lists them: "a, b and c". */
const LISTED_TOOLS = (names => `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)([...metaTools.keys()]);

/** Why a call to a tool the server does not have is refused, and what the client hears. */
export interface UnknownTool {
  refusal: 'operation_as_tool' | 'unknown_tool';
  /** The operation the tool name is, when it is one. */
  operation?: string;
  message: string;
}

/**
 * A call to a tool the server does not have. An operation's name was its own tool before the
 * meta-tools, so a client that still calls it learns how to run it now. A client that keeps the
 * tool list it fetched earlier, as a ChatGPT app does until it is refreshed, has none of the
 * meta-tools to call, so its model is told to ask the user to refresh the server's tools.
 */
export function unknownTool(toolName: string): UnknownTool {
  const operation = operations.get(toolName);

  if (!operation) {
    return { refusal: 'unknown_tool', message: `Unknown tool requested: ${toolName}. Find what you need with ${SEARCH_OPERATIONS}.` };
  }

  return {
    refusal: 'operation_as_tool',
    operation: operation.id,
    message: `There is no tool "${toolName}": it is an operation. Run it with ${runToolOf(operation)}, with the arguments ${DESCRIBE_OPERATION} shows for it. If ${LISTED_TOOLS} are not among your tools, your list of this server's tools is out of date: ask the user to refresh this server's tools in their client, or to remove the server and add it again.`,
  };
}

/** The most each run tool runs: any operation at that level or below. */
const RUN_TOOL_LEVELS: Record<string, OperationLevel> = {
  [READ_OPERATION]: 'read',
  [CALL_OPERATION]: 'write',
  [DELETE_OPERATION]: 'delete',
};

/** The run tool an operation of each level is meant for: the least one that runs it. */
const RUN_TOOL_FOR: Record<OperationLevel, string> = {
  read: READ_OPERATION,
  write: CALL_OPERATION,
  delete: DELETE_OPERATION,
};

const LEVEL_DOES: Record<OperationLevel, string> = {
  read: 'only reads',
  write: 'changes data',
  delete: 'deletes data',
};

export function isRunTool(toolName: string): boolean {
  return Object.hasOwn(RUN_TOOL_LEVELS, toolName);
}

/** The tool that runs an operation. */
export function runToolOf(operation: Operation): string {
  const runTool = RUN_TOOL_FOR[operation.level];

  return operation.definition.readOnlyCall && runTool !== READ_OPERATION
    ? `${runTool}, or ${READ_OPERATION} for a call that only reads`
    : runTool;
}

/** The operations a grant may run: all of them when scopes are not enforced. */
export function grantedOperations(scopes: string[], enforcement: ScopeEnforcement): Operation[] {
  const all = [...operations.values()];

  if (enforcement === 'off') {
    return all;
  }

  const visible = new Set(visibleTools(scopes));

  return all.filter(operation => visible.has(operation.id));
}

export function searchOperationsResult(args: JsonObject, granted: Operation[]): CallToolResult {
  // A client may send null for an argument it leaves out
  const query = args.query ?? '';
  const category = args.category ?? undefined;
  const limit = args.limit ?? undefined;

  if (typeof query !== 'string') {
    return text('query must be text.', true);
  }

  if (category !== undefined && !CATEGORIES.includes(category)) {
    return text(`category must be one of: ${CATEGORIES.join(', ')}.`, true);
  }

  if (limit !== undefined && !Number.isInteger(limit)) {
    return text(`limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}.`, true);
  }

  const { found, total } = searchOperations(query, { category: category as OperationCategory | undefined, limit, operations: granted });

  if (found.length === 0) {
    return text(`No operation matches "${query}". Search in other words, or list a category with an empty query: ${CATEGORIES.join(', ')}.`);
  }

  return text([
    'id | title | category | run with | tokens to describe',
    ...found.map(operation => [operation.id, operation.title, operation.category, runToolOf(operation), describeTokens(operation)].join(' | ')),
    ...(total > found.length
      ? [`Showing ${found.length} of ${total}: ${found.length < MAX_SEARCH_LIMIT ? `raise limit, up to ${MAX_SEARCH_LIMIT}, or ` : ''}narrow the search to see the rest.`]
      : []),
  ].join('\n'));
}

export function describeOperationsResult(args: JsonObject, granted: Operation[]): CallToolResult {
  const { ids } = args;

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
    return text(`ids must list the IDs of operations, from ${SEARCH_OPERATIONS}.`, true);
  }

  const unique = [...new Set(ids as string[])];

  if (unique.length > MAX_DESCRIBED_OPERATIONS) {
    return text(`Describe at most ${MAX_DESCRIBED_OPERATIONS} operations at a time.`, true);
  }

  const grantedIds = new Set(granted.map(operation => operation.id));
  const described = unique.map(id => {
    const operation = operations.get(id);

    if (!operation) {
      return { id, error: unknownOperation(id) };
    }

    if (!grantedIds.has(id)) {
      return { id, error: notGrantedMessage(id, requiredScope(id)) };
    }

    return describedEntry(operation);
  });

  return text(JSON.stringify(described), described.every(entry => 'error' in entry));
}

/** What describe_operation returns for one operation. */
function describedEntry(operation: Operation): JsonObject {
  return {
    id: operation.id,
    title: operation.title,
    category: operation.category,
    runWith: runToolOf(operation),
    description: operation.definition.description,
    inputSchema: operation.definition.inputSchema,
    example: operationExample(operation),
  };
}

/** The example arguments describe_operation shows for an operation. */
export function operationExample(operation: Operation): JsonObject {
  return Object.hasOwn(EXAMPLE_ARGUMENTS, operation.id)
    ? EXAMPLE_ARGUMENTS[operation.id]
    : exampleArguments(operation.definition.inputSchema);
}

const describeCosts = new Map<string, number>();

/** Roughly how many tokens describe_operation takes to describe an operation, as a search shows it. */
export function describeTokens(operation: Operation): number {
  let cost = describeCosts.get(operation.id);

  if (cost === undefined) {
    cost = estimateTokens(describedEntry(operation));
    describeCosts.set(operation.id, cost);
  }

  return cost;
}

/**
 * The operation a run tool call names, with its arguments, or why it cannot run: an unknown
 * operation, arguments put next to its ID, or an operation above what the tool runs.
 */
export function resolveRun(toolName: string, args: JsonObject): RunResolution {
  const { id } = args;
  const operationArgs = args.arguments ?? {};

  if (typeof id !== 'string' || id === '') {
    return { refusal: 'invalid_arguments', message: `Give the ID of an operation, from ${SEARCH_OPERATIONS}.` };
  }

  const operation = operations.get(id);

  if (!operation) {
    return { refusal: 'unknown_operation', message: unknownOperation(id) };
  }

  if (typeof operationArgs !== 'object' || operationArgs === null || Array.isArray(operationArgs)) {
    return { refusal: 'invalid_arguments', message: `arguments must be an object, as ${DESCRIBE_OPERATION} shows for "${id}".` };
  }

  // An argument next to the ID would be dropped, and the operation run without it. A null one
  // drops nothing: a client may send null for what it leaves out.
  const misplaced = Object.keys(args).filter(key => !RUN_KEYS.includes(key) && args[key] != null);

  if (misplaced.length > 0) {
    return {
      refusal: 'misplaced_arguments',
      message: `${toolName} takes only ${listed(RUN_KEYS)}, not ${listed(misplaced)}. Give every argument of "${id}" inside arguments, named as ${DESCRIBE_OPERATION} shows them.`,
    };
  }

  const level = callLevel(operation, operationArgs);

  // A run tool runs anything at its level or below: a read through call_operation is only asked
  // about more than it needs to be. One above its level would skip the client's confirmation.
  if (LEVELS.indexOf(level) > LEVELS.indexOf(isRunTool(toolName) ? RUN_TOOL_LEVELS[toolName] : 'read')) {
    return { refusal: 'wrong_run_tool', message: `"${id}" ${LEVEL_DOES[level]}, so run it with ${RUN_TOOL_FOR[level]}.` };
  }

  return { operation, args: operationArgs };
}

/** Names as a sentence lists them: "a", "a and b", "a, b and c". */
function listed(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What a scope check covers for one tools/call: the operation a run tool would run, with its
 * arguments. null for a call that runs no operation, or that the tool handler refuses anyway, so
 * the client hears why instead of being asked to grant a permission the call would not use.
 */
export function scopedCallOf(toolName: string, args: JsonObject): { name: string; args: JsonObject } | null {
  if (!isRunTool(toolName)) {
    return null;
  }

  const run = resolveRun(toolName, args);

  return 'refusal' in run ? null : { name: run.operation.id, args: run.args };
}

/**
 * Arguments that fill every required field of an input schema, with each field's example, default
 * or first allowed value where the schema gives one, and a placeholder otherwise. A union takes
 * its first option.
 */
export function exampleArguments(schema: JsonObject): JsonObject {
  const example = exampleOf(schema, 'arguments', 0);

  return typeof example === 'object' && example !== null && !Array.isArray(example) ? example as JsonObject : {};
}

function exampleOf(schema: any, name: string, depth: number): unknown {
  if (!schema || typeof schema !== 'object' || depth > MAX_EXAMPLE_DEPTH) {
    return undefined;
  }

  if (schema.example !== undefined) {
    return schema.example;
  }

  if (schema.default !== undefined) {
    return schema.default;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.find((value: unknown) => value !== '' && value !== null) ?? schema.enum[0];
  }

  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key]) && schema[key].length > 0) {
      return exampleOf(schema[key][0], name, depth + 1);
    }
  }

  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.map((part: unknown) => exampleOf(part, name, depth + 1)).filter((part: unknown) => part !== undefined);

    return parts.every(isPlainObject) ? Object.assign({}, ...parts) : parts[0];
  }

  const type = Array.isArray(schema.type) ? schema.type.find((option: unknown) => option !== 'null') : schema.type;

  switch (type ?? (schema.properties ? 'object' : undefined)) {
    case 'object':
      return Object.fromEntries((schema.required ?? []).map((field: string) => [
        field,
        orPlaceholder(exampleOf(schema.properties?.[field], field, depth + 1), field),
      ]));
    case 'array':
      return (schema.minItems ?? 0) > 0 ? [orPlaceholder(exampleOf(schema.items, name, depth + 1), name)] : [];
    case 'string':
      return `<${name}>`;
    case 'integer':
    case 'number':
      return numberExample(schema, type);
    case 'boolean':
      return false;
    default:
      return undefined;
  }
}

/** A value the schema gave, null included, or a placeholder where it gave none. */
function orPlaceholder(value: unknown, name: string): unknown {
  return value === undefined ? `<${name}>` : value;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberExample(schema: any, type: string): number {
  if (typeof schema.exclusiveMinimum === 'number') {
    return type === 'integer' ? Math.floor(schema.exclusiveMinimum) + 1 : schema.exclusiveMinimum + 1;
  }

  if (typeof schema.minimum === 'number') {
    return schema.exclusiveMinimum === true ? schema.minimum + 1 : schema.minimum;
  }

  return 1;
}
