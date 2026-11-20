/**
 * The tools are generated from the API spec and then edited by hand; this keeps them from drifting
 * from it again: every spec operation has one tool, with the same parameters and body fields, and
 * each field takes the same types and values.
 * docs/apiv4.json is a copy of docs/apiv4.json in the api repository, generated there from apiv4.yaml.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolDefinitionMap } from '../tools.js';
import { simplifySchemaForOpenAI } from '../schema.js';

const spec = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/apiv4.json'), 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const normalise = (path: string) => '/' + path.replace(/^\/+|\/+$/g, '').replace(/\{[^}]+\}/g, '{}');

function dereference(node: any, depth = 0): any {
  if (depth > 40 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => dereference(item, depth + 1));
  if (typeof node.$ref === 'string') {
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((at: any, part: string) => at[part], spec);
    return dereference(target, depth + 1);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, dereference(value, depth + 1)]));
}

/** Every property path a schema can carry, through unions, arrays and nested objects. */
function fields(schema: any, prefix = ''): Set<string> {
  const found = new Set<string>();
  if (!schema || typeof schema !== 'object') return found;
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    for (const option of schema[key] ?? []) fields(option, prefix).forEach((field) => found.add(field));
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const path = prefix ? `${prefix}.${name}` : name;
    found.add(path);
    fields(property, path).forEach((field) => found.add(field));
  }
  if (schema.items && typeof schema.items === 'object') fields(schema.items, `${prefix}[]`).forEach((field) => found.add(field));
  return found;
}

/**
 * What each body field accepts, by path: its types, its values and the fields it requires. A
 * field a union gives more than one shape keeps them all. The tools write OpenAPI's nullable as
 * a "null" type, and were generated with integer written as number: to a client both are a JSON
 * number, and the API turns down a fraction where it wants a whole one.
 */
function shapes(schema: any, prefix = '', found = new Map<string, Set<string>>()): Map<string, Set<string>> {
  if (!schema || typeof schema !== 'object') return found;
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    for (const option of schema[key] ?? []) shapes(option, prefix, found);
  }
  const types = [...new Set([schema.type ?? []].flat().concat(schema.nullable ? ['null'] : []))]
    .map((type) => (type === 'integer' ? 'number' : type))
    .sort();
  const shape = JSON.stringify({
    types,
    enum: schema.enum ? schema.enum.map(String).sort() : undefined,
    required: schema.required ? [...schema.required].sort() : undefined,
  });
  found.set(prefix, (found.get(prefix) ?? new Set()).add(shape));
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    shapes(property, prefix ? `${prefix}.${name}` : name, found);
  }
  if (schema.items && typeof schema.items === 'object') shapes(schema.items, `${prefix}[]`, found);
  return found;
}

/** Body fields whose tool and spec still differ, by tool and field, and how. None do now. */
const KNOWN_DRIFT: Record<string, string> = {};

interface Operation {
  key: string;
  parameters: string[];
  body: Set<string>;
  schema: any;
}

const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]: [string, any]) =>
  Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, operation]: [string, any]) => {
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter: any) => dereference(parameter))
        .filter((parameter: any) => parameter.in === 'path' || parameter.in === 'query')
        .map((parameter: any) => `${parameter.in}:${parameter.name}`)
        .sort();
      const content = dereference(operation.requestBody)?.content ?? {};
      const schema = (Object.values(content)[0] as any)?.schema;
      return { key: `${method.toUpperCase()} ${normalise(path)}`, parameters, body: fields(schema), schema };
    }),
);

const tools = [...toolDefinitionMap.values()].map((tool) => ({
  tool,
  key: `${tool.method.toUpperCase()} ${normalise(tool.pathTemplate)}`,
}));

const difference = (a: Set<string>, b: Set<string>) => [...a].filter((item) => !b.has(item)).sort();

describe('tool catalogue', () => {
  it('has one tool for every operation of the API spec', () => {
    const missing = operations.filter((operation) => !tools.some(({ key }) => key === operation.key)).map(({ key }) => key);
    const duplicated = operations.filter((operation) => tools.filter(({ key }) => key === operation.key).length > 1).map(({ key }) => key);

    expect({ missing, duplicated }).toEqual({ missing: [], duplicated: [] });
  });

  it('has no tool for an operation the spec does not describe', () => {
    expect(tools.filter(({ key }) => !operations.some((operation) => operation.key === key)).map(({ tool }) => tool.name)).toEqual([]);
  });

  it('gives every tool the parameters of its operation', () => {
    const drifted = tools.flatMap(({ tool, key }) => {
      const operation = operations.find((candidate) => candidate.key === key);
      if (!operation) return [];
      const executed = tool.executionParameters.map(({ name, in: where }) => `${where}:${name}`).sort();
      return JSON.stringify(executed) === JSON.stringify(operation.parameters) ? [] : [`${tool.name}: ${executed} != ${operation.parameters}`];
    });

    expect(drifted).toEqual([]);
  });

  it('gives every tool the body fields of its operation', () => {
    const drifted = tools.flatMap(({ tool, key }) => {
      const operation = operations.find((candidate) => candidate.key === key);
      if (!operation) return [];
      const body = fields(tool.inputSchema.properties?.requestBody);
      const missing = difference(operation.body, body);
      const extra = difference(body, operation.body);
      return missing.length || extra.length ? [`${tool.name}: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`] : [];
    });

    expect(drifted).toEqual([]);
  });

  const drift = tools.flatMap(({ tool, key }) => {
    const operation = operations.find((candidate) => candidate.key === key);
    if (!operation?.schema) return [];
    const own = shapes(tool.inputSchema.properties?.requestBody);
    return [...shapes(operation.schema)].flatMap(([path, shape]) => {
      const toolShape = own.get(path);
      if (!toolShape || JSON.stringify([...toolShape].sort()) === JSON.stringify([...shape].sort())) return [];
      return [{ field: `${tool.name} ${path || '(body)'}`, detail: `${[...toolShape].join(' or ')} != ${[...shape].join(' or ')}` }];
    });
  });

  it('gives every body field the types, values and required fields of its operation', () => {
    expect(drift.filter(({ field }) => !(field in KNOWN_DRIFT)).map(({ field, detail }) => `${field}: ${detail}`)).toEqual([]);
  });

  it('lists as known drift only fields that still drift', () => {
    expect(Object.keys(KNOWN_DRIFT).filter((field) => !drift.some((drifted) => drifted.field === field))).toEqual([]);
  });
});

/**
 * Clients check a tool's input schema against JSON Schema 2020-12 and leave out a tool whose schema
 * is not one. In the spec, OpenAPI 3.0, exclusiveMinimum and exclusiveMaximum are booleans that make
 * minimum and maximum exclusive; in JSON Schema they are the bound itself, a number.
 */
function booleanBounds(schema: any, path: string): string[] {
  if (!schema || typeof schema !== 'object') return [];
  return ['exclusiveMinimum', 'exclusiveMaximum']
    .filter((keyword) => keyword in schema && typeof schema[keyword] !== 'number')
    .map((keyword) => `${path}.${keyword}`)
    .concat(Object.entries(schema).flatMap(([key, value]) => booleanBounds(value, `${path}.${key}`)));
}

describe('tool input schemas', () => {
  it('give exclusive bounds as JSON Schema does, in the definitions and as listed to clients', () => {
    const found = [...toolDefinitionMap.values()].flatMap((tool) => [
      ...booleanBounds(tool.inputSchema, `${tool.name} definition`),
      ...booleanBounds(simplifySchemaForOpenAI(tool.inputSchema), `${tool.name} listed`),
    ]);

    expect(found).toEqual([]);
  });
});

/** The e-invoice operations carry text the spec keeps elsewhere or words for its docs, named here for an MCP client. */
describe('the e-invoice operations', () => {
  const forClient = (text: string) => text
    .replaceAll('Use the Get schema endpoint to see', 'Use `get_einvoice_schema` to see')
    .replaceAll('list in the Get schema endpoint', 'list of `get_einvoice_schema`');
  const creditNotes = (spec.tags.find((tag: { name: string }) => tag.name === 'eInvoices').description as string).trim();
  const creditNoteRules = creditNotes
    .split('\n')
    .filter((line) => line.startsWith('* '))
    .map(forClient);
  const [, creditNoteIntro, , creditNoteOutput] = creditNotes.split('\n\n').map((paragraph) => paragraph.trim());
  /** Each operation keeps the part of the spec's output paragraph that applies to what it produces. */
  const ownOutput: Record<string, string> = {
    create_einvoice: creditNoteOutput,
    create_xrechnung_einvoice: creditNoteOutput.replace('CII output, including Factur-X, carries', 'CII output carries'),
    create_facturx_einvoice: `Factur-X ${creditNoteOutput.slice(creditNoteOutput.indexOf('carries the code in'))}`,
  };
  const operations = [
    ['create_einvoice', '/einvoice'],
    ['create_xrechnung_einvoice', '/einvoice/xrechnung'],
    ['create_facturx_einvoice', '/einvoice/facturx'],
  ];

  function dataOf(schema: unknown): { description?: string } | undefined {
    if (schema === null || typeof schema !== 'object') return undefined;
    const properties = (schema as { properties?: Record<string, unknown> }).properties;
    if (properties?.data) return properties.data as { description?: string };
    for (const value of Object.values(schema)) {
      const data = dataOf(value);
      if (data) return data;
    }
    return undefined;
  }

  it.each(operations)('%s says how to make a credit note, rule for rule as the spec does', (tool) => {
    expect(creditNoteRules).toHaveLength(3);
    for (const rule of creditNoteRules) {
      expect(toolDefinitionMap.get(tool)!.description).toContain(rule);
    }
  });

  it.each(operations)('%s says what a credit note becomes in its output, in the spec\'s words', (tool) => {
    const description = toolDefinitionMap.get(tool)!.description;

    expect(description).toContain(forClient(creditNoteIntro));
    expect(description).toContain(forClient(ownOutput[tool]));
  });

  it.each(operations)('%s describes its own data as the spec does', (tool, path) => {
    const specData = dataOf(dereference(spec.paths[path].post.requestBody.content['application/json'].schema));

    expect(dataOf(toolDefinitionMap.get(tool)!.inputSchema)!.description).toBe(forClient(specData!.description!));
  });
});
