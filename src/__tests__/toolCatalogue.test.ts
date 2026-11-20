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
import { exampleArguments } from '../metaTools.js';

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
 * A field's limits. OpenAPI 3.0 makes a bound exclusive with a boolean beside minimum or maximum;
 * the tools give JSON Schema's number instead, which clients require, and both read the same here.
 */
function limits(schema: any): Record<string, unknown> {
  const bound = (value: unknown, exclusive: unknown) =>
    typeof exclusive === 'number' ? { value: exclusive, exclusive: true, ...(value === undefined ? {} : { inclusive: value }) }
      : value === undefined ? undefined : { value, exclusive: exclusive === true };
  return {
    minimum: bound(schema.minimum, schema.exclusiveMinimum),
    maximum: bound(schema.maximum, schema.exclusiveMaximum),
    minLength: schema.minLength,
    maxLength: schema.maxLength,
    pattern: schema.pattern,
    minItems: schema.minItems,
    maxItems: schema.maxItems,
    uniqueItems: schema.uniqueItems,
    minProperties: schema.minProperties,
    maxProperties: schema.maxProperties,
    multipleOf: schema.multipleOf,
    format: schema.format,
  };
}

/**
 * What each body field accepts, by path: its types, its values, its limits and the fields it requires. A
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
    ...limits(schema),
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

/**
 * The spec's words for a client of this server: it names the operation that returns a schema,
 * where the spec names the endpoint.
 */
function clientWording(text: string, path: string): string {
  const schemaOperation = path.startsWith('/einvoice') ? '`get_einvoice_schema`' : '`get_template_schema`';
  return text
    .replaceAll('Use the Get schema endpoint to see', `Use ${schemaOperation} to see`)
    .replaceAll('list in the Get schema endpoint', `list of ${schemaOperation}`)
    .replaceAll('the template schema (Get schema endpoint)', schemaOperation);
}

/** Every value a schema gives for an annotation, by property path, through unions, arrays and nested objects. */
function annotations(schema: any, annotation: string, prefix = '', found = new Map<string, unknown>()): Map<string, unknown> {
  if (!schema || typeof schema !== 'object') return found;
  if (schema[annotation] !== undefined) found.set(prefix, schema[annotation]);
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    (schema[key] ?? []).forEach((option: any, index: number) => annotations(option, annotation, `${prefix}<${key}${index}>`, found));
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    annotations(property, annotation, prefix ? `${prefix}.${name}` : name, found);
  }
  if (schema.items && typeof schema.items === 'object') annotations(schema.items, annotation, `${prefix}[]`, found);
  return found;
}

/** Every description a schema gives, by property path. */
const descriptions = (schema: any, prefix = '') => annotations(schema, 'description', prefix) as Map<string, string>;

/** Fields whose tool says it in other words than the spec, by tool and field, and why. */
const OWN_WORDING: Record<string, string> = {
  'get_template_library_items ids': 'the tool takes the ids as a list, where the API takes them comma separated',
};

interface Operation {
  key: string;
  path: string;
  parameters: string[];
  parameterSchemas: Map<string, any>;
  body: Set<string>;
  bodyRequired: boolean;
  schema: any;
}

const operations: Operation[] = Object.entries(spec.paths).flatMap(([path, item]: [string, any]) =>
  Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, operation]: [string, any]) => {
      const declared = [...(item.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter: any) => dereference(parameter))
        .filter((parameter: any) => parameter.in === 'path' || parameter.in === 'query');
      const parameters = declared.map((parameter: any) => `${parameter.in}:${parameter.name}`).sort();
      const parameterSchemas = new Map<string, any>(declared.map((parameter: any) => [
        parameter.name,
        { ...parameter.schema, ...(parameter.description ? { description: parameter.description } : {}) },
      ]));
      const requestBody = dereference(operation.requestBody);
      const schema = (Object.values(requestBody?.content ?? {})[0] as any)?.schema;
      return {
        key: `${method.toUpperCase()} ${normalise(path)}`,
        path,
        parameters,
        parameterSchemas,
        body: fields(schema),
        bodyRequired: requestBody?.required === true,
        schema,
      };
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

  it('requires the body wherever its operation does', () => {
    const drifted = tools.flatMap(({ tool, key }) => {
      const operation = operations.find((candidate) => candidate.key === key);
      if (!operation?.schema) return [];
      const required = ((tool.inputSchema as any).required ?? []).includes('requestBody');
      return required === operation.bodyRequired ? [] : [`${tool.name}: body ${required ? 'required' : 'optional'}, spec ${operation.bodyRequired ? 'required' : 'optional'}`];
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

  it('gives every body field the types, values, limits and required fields of its operation', () => {
    expect(drift.filter(({ field }) => !(field in KNOWN_DRIFT)).map(({ field, detail }) => `${field}: ${detail}`)).toEqual([]);
  });

  it('lists as known drift only fields that still drift', () => {
    expect(Object.keys(KNOWN_DRIFT).filter((field) => !drift.some((drifted) => drifted.field === field))).toEqual([]);
  });

  it('gives every parameter the type, values and limits of its operation', () => {
    const drifted = tools.flatMap(({ tool, key }) => {
      const operation = operations.find((candidate) => candidate.key === key);
      const shapeOf = (schema: any) => JSON.stringify([...shapes(schema)].map(([path, shape]) => [path, [...shape].sort()]));
      return [...(operation?.parameterSchemas ?? [])].flatMap(([name, schema]) => {
        const own = shapeOf(tool.inputSchema.properties?.[name]);
        const theirs = shapeOf(schema);
        return own === theirs ? [] : [`${tool.name} ${name}: ${own} != ${theirs}`];
      });
    });

    expect(drifted).toEqual([]);
  });

  const wording = tools.flatMap(({ tool, key }) => {
    const operation = operations.find((candidate) => candidate.key === key);
    if (!operation) return [];
    const theirs = new Map([
      ...descriptions(operation.schema),
      ...[...operation.parameterSchemas].flatMap(([name, schema]) => [...descriptions(schema, name)]),
    ]);
    const own = new Map([
      ...descriptions(tool.inputSchema.properties?.requestBody),
      ...[...operation.parameterSchemas.keys()].flatMap((name) => [...descriptions(tool.inputSchema.properties?.[name], name)]),
    ]);
    return [...theirs].flatMap(([field, text]) => {
      const expected = clientWording(text, operation.path);
      return own.get(field) === expected ? [] : [{ field: `${tool.name} ${field}`, detail: `${JSON.stringify(own.get(field))} != ${JSON.stringify(expected)}` }];
    });
  });

  it('describes every field and parameter as the spec does, naming the schema operations for a client', () => {
    expect(wording.filter(({ field }) => !(field in OWN_WORDING)).map(({ field, detail }) => `${field}: ${detail}`)).toEqual([]);
  });

  it('gives every file URL the example its operation gives', () => {
    const differing = tools.flatMap(({ tool, key }) => {
      const operation = operations.find((candidate) => candidate.key === key);
      if (!operation?.schema) return [];
      const own = annotations(tool.inputSchema.properties?.requestBody, 'example');
      return [...annotations(operation.schema, 'example')]
        .filter(([field]) => field.endsWith('file_url'))
        .flatMap(([field, example]) => JSON.stringify(own.get(field)) === JSON.stringify(example)
          ? [] : [`${tool.name} ${field}: ${JSON.stringify(own.get(field))} != ${JSON.stringify(example)}`]);
    });

    expect(differing).toEqual([]);
  });

  it('gives store_document no empty name to fill in, which the API refuses', () => {
    const name = (toolDefinitionMap.get('store_document')!.inputSchema as any).properties.requestBody.properties.name;
    expect(name).not.toHaveProperty('default');
  });

  it('shows a PDF operation a file URL rather than a placeholder in its example arguments', () => {
    expect(exampleArguments(toolDefinitionMap.get('optimize_document')!.inputSchema as any))
      .toEqual({ requestBody: { file_url: 'https://example.com/document.pdf' } });
  });

  it('lists as its own wording only fields that still differ', () => {
    expect(Object.keys(OWN_WORDING).filter((field) => !wording.some((differing) => differing.field === field))).toEqual([]);
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
  const forClient = (text: string) => clientWording(text, '/einvoice');
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
