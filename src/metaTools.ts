/**
 * The tools a client sees instead of one per operation: it searches the catalogue, describes the
 * operations it is about to run, and runs each with the tool that matches what it does, so its
 * hints tell the client whether to ask first.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { JsonObject } from './types.js';
import type { ToolAnnotations } from './annotations.js';
import {
  CATEGORIES,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  isReadOnlyCall,
  operations,
  searchOperations,
  type Operation,
  type OperationCategory,
} from './operations.js';
import { requiredScope, visibleTools, type ScopeEnforcement } from './auth/scopes.js';
import { RUN_BUILDER_TOOL } from './builder.js';

export const SEARCH_OPERATIONS = 'search_operations';
export const DESCRIBE_OPERATION = 'describe_operation';
export const READ_OPERATION = 'read_operation';
export const CALL_OPERATION = 'call_operation';

export const MAX_DESCRIBED_OPERATIONS = 5;

const MAX_EXAMPLE_DEPTH = 10;

export interface MetaTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  annotations: ToolAnnotations;
}

/** Why a run was refused before it reached the API, as telemetry records it. */
export type RunRefusal = 'invalid_arguments' | 'unknown_operation' | 'wrong_run_tool';

export type RunResolution =
  | { operation: Operation; args: JsonObject }
  | { refusal: RunRefusal; message: string };

const runInputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: `ID of the operation, from ${SEARCH_OPERATIONS}.` },
    arguments: {
      type: 'object',
      description: `The operation's arguments, as the input schema ${DESCRIBE_OPERATION} returns gives them.`,
    },
  },
  required: ['id'],
};

export const metaTools: Map<string, MetaTool> = new Map([
  [SEARCH_OPERATIONS, {
    name: SEARCH_OPERATIONS,
    description: `Finds the PDF Generator API operations for a task: templates and their versions, the template builder and previews, documents, workspaces, forms, PDF tools (convert HTML or a URL to PDF, watermark, encrypt, optimize, fill form fields, QR codes), e-invoices and the service status. Returns each match's ID, title, category, the tool that runs it and how many tokens its schema costs, best match first. Search in a few plain words, such as "add a watermark" or "list templates"; an empty query lists a category. Then describe the operations you will run with ${DESCRIBE_OPERATION}.`,
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
    description: `Returns what operations take, for IDs that ${SEARCH_OPERATIONS} found: each one's description, its whole input schema, example arguments that fill every required field, and the tool that runs it. Describe only the operations you are about to run, up to ${MAX_DESCRIBED_OPERATIONS} at a time: each schema costs the tokens ${SEARCH_OPERATIONS} shows.`,
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
    description: `Runs an operation that only reads: one that lists or gets something, a schema, a preview, the service status, or a template builder tool that only reads. Give the operation's ID and its arguments, as ${DESCRIBE_OPERATION} shows them. An operation that creates, changes or deletes something runs with ${CALL_OPERATION}.`,
    inputSchema: runInputSchema,
    annotations: { title: 'Run a Read-Only Operation', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }],
  [CALL_OPERATION, {
    name: CALL_OPERATION,
    description: `Runs an operation that creates, changes or deletes something, or that generates or converts a document: create or update a template, generate a document, convert HTML to PDF, delete a workspace, or run a template builder tool that changes the template. Give the operation's ID and its arguments, as ${DESCRIBE_OPERATION} shows them. Ask for a document as a link (output url or viewer) only when the user wants one: a link stores the document for 30 days. An operation that only reads runs with ${READ_OPERATION}.`,
    inputSchema: runInputSchema,
    annotations: { title: 'Run an Operation', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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

/**
 * What a call to a tool the server does not have hears. An operation's name was its own tool
 * before the meta-tools, so a client that still calls it learns how to run it now.
 */
export function unknownToolMessage(toolName: string): string {
  const operation = operations.get(toolName);

  return operation
    ? `There is no tool "${toolName}": it is an operation. Run it with ${runToolOf(operation)}, with the arguments ${DESCRIBE_OPERATION} shows for it.`
    : `Unknown tool requested: ${toolName}. Find what you need with ${SEARCH_OPERATIONS}.`;
}

/** The tool that runs an operation. */
export function runToolOf(operation: Operation): string {
  if (operation.id === RUN_BUILDER_TOOL) {
    return `${CALL_OPERATION}, or ${READ_OPERATION} for a builder tool that only reads`;
  }

  return operation.readOnly ? READ_OPERATION : CALL_OPERATION;
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

  const found = searchOperations(query, { category: category as OperationCategory | undefined, limit, operations: granted });

  if (found.length === 0) {
    return text(`No operation matches "${query}". Search in other words, or list a category with an empty query: ${CATEGORIES.join(', ')}.`);
  }

  return text([
    'id | title | category | run with | schema tokens',
    ...found.map(operation => [operation.id, operation.title, operation.category, runToolOf(operation), operation.schemaTokens].join(' | ')),
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

    return {
      id,
      title: operation.title,
      category: operation.category,
      runWith: runToolOf(operation),
      description: operation.definition.description,
      inputSchema: operation.definition.inputSchema,
      example: exampleArguments(operation.definition.inputSchema),
    };
  });

  return text(JSON.stringify(described), described.every(entry => 'error' in entry));
}

/**
 * The operation a read_operation or call_operation call names, with its arguments, or why it
 * cannot run: an unknown operation, or one the other tool runs.
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

  const readOnly = isReadOnlyCall(operation, operationArgs);

  if (toolName === READ_OPERATION && !readOnly) {
    return { refusal: 'wrong_run_tool', message: `"${id}" changes data, so run it with ${CALL_OPERATION}.` };
  }

  if (toolName === CALL_OPERATION && readOnly) {
    return { refusal: 'wrong_run_tool', message: `"${id}" only reads, so run it with ${READ_OPERATION}.` };
  }

  return { operation, args: operationArgs };
}

/**
 * What a scope check covers for one tools/call: the operation a run tool would run, with its
 * arguments. null for a call that runs no operation, or that the tool handler refuses anyway, so
 * the client hears why instead of being asked to grant a permission the call would not use.
 */
export function scopedCallOf(toolName: string, args: JsonObject): { name: string; args: JsonObject } | null {
  if (toolName !== READ_OPERATION && toolName !== CALL_OPERATION) {
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
