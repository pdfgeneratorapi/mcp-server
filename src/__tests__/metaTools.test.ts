import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const {
  CALL_OPERATION,
  DESCRIBE_OPERATION,
  READ_OPERATION,
  SEARCH_OPERATIONS,
  describeOperationsResult,
  exampleArguments,
  grantedOperations,
  metaTools,
  resolveRun,
  runToolOf,
  searchOperationsResult,
  visibleMetaTools,
} = await import('../metaTools.js');
const { operations } = await import('../operations.js');
const { executeApiTool } = await import('../execute.js');
const { createMcpServer } = await import('../server.js');
const { createStaticCredentials } = await import('../credentials/upstream.js');
const { API_BASE_URL } = await import('../config.js');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

const all = [...operations.values()];
const operation = (id: string) => operations.get(id)!;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

beforeEach(() => {
  mockAxios.mockReset();
});

async function connectedClient() {
  const server = createMcpServer(createStaticCredentials('upstream-token'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return client;
}

describe('the meta-tools', () => {
  it('are the four tools that search, describe and run operations', () => {
    expect([...metaTools.keys()]).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION, CALL_OPERATION]);
  });

  /** Clients skip the confirmation for read-only tools, so only a run that changes nothing may claim it. */
  it('hint that only call_operation changes or destroys anything', () => {
    expect(metaTools.get(SEARCH_OPERATIONS)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(metaTools.get(DESCRIBE_OPERATION)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(metaTools.get(READ_OPERATION)!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(metaTools.get(CALL_OPERATION)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('name the tool that runs each operation', () => {
    expect(runToolOf(operation('get_templates'))).toBe('read_operation');
    expect(runToolOf(operation('preview_template'))).toBe('read_operation');
    expect(runToolOf(operation('delete_template'))).toBe('call_operation');
    expect(runToolOf(operation('convert_html_to_pdf'))).toBe('call_operation');
    expect(runToolOf(operation('run_builder_tool'))).toBe('call_operation, or read_operation for a builder tool that only reads');
  });
});

describe('grantedOperations', () => {
  it('grants every operation when scopes are not enforced, or the token carries none', () => {
    expect(grantedOperations(['templates:read'], 'off')).toHaveLength(all.length);
    expect(grantedOperations([], 'enforce')).toHaveLength(all.length);
  });

  it('grants what the scopes allow, with the operations that need no scope', () => {
    const ids = grantedOperations(['templates:read'], 'enforce').map(item => item.id);

    expect(ids).toEqual(expect.arrayContaining(['get_templates', 'run_builder_tool', 'get_status', 'get_template_library']));
    expect(ids).not.toContain('delete_template');
    expect(ids).not.toContain('generate_document');
  });

  it('hides what a grant cannot run in warn mode too, as tools/list does', () => {
    expect(grantedOperations(['templates:read'], 'warn').map(item => item.id)).not.toContain('delete_template');
  });

  it('counts the narrower scopes a broader one implies', () => {
    expect(grantedOperations(['templates:delete'], 'enforce').map(item => item.id))
      .toEqual(expect.arrayContaining(['delete_template', 'update_template', 'get_template']));
  });
});

describe('visibleMetaTools', () => {
  const names = (scopes: string[], enforcement: 'off' | 'warn' | 'enforce' = 'enforce') =>
    visibleMetaTools(scopes, enforcement).map(tool => tool.name);

  it('offers all four when scopes are not enforced, or the token carries none', () => {
    expect(names(['templates:read'], 'off')).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION, CALL_OPERATION]);
    expect(names([])).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION, CALL_OPERATION]);
  });

  it.each([
    [['templates:read']],
    [['documents:read', 'forms:read', 'workspaces:read']],
  ])('leaves call_operation out for %j, which can change nothing', (scopes) => {
    expect(names(scopes)).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION]);
    expect(names(scopes, 'warn')).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION]);
  });

  it.each([
    [['templates:write']],
    [['documents:write']],
    [['pdf:write']],
    [['forms:share']],
  ])('offers call_operation to %j', (scopes) => {
    expect(names(scopes)).toContain(CALL_OPERATION);
  });
});

describe('search_operations', () => {
  it('lists each match on a line: id, title, category, the tool that runs it and its schema tokens', () => {
    const result = searchOperationsResult({ query: 'watermark' }, all);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe([
      'id | title | category | run with | schema tokens',
      `add_watermark | Add Watermark to PDF | pdf | call_operation | ${operation('add_watermark').schemaTokens}`,
    ].join('\n'));
  });

  it('searches only the granted operations', () => {
    const granted = grantedOperations(['templates:read'], 'enforce');

    expect(textOf(searchOperationsResult({ query: 'delete template' }, granted))).not.toContain('delete_template');
  });

  it('lists a category for an empty query, and takes a limit', () => {
    const lines = textOf(searchOperationsResult({ category: 'workspaces', limit: 2 }, all)).split('\n');

    expect(lines.slice(1).map(line => line.split(' | ')[0])).toEqual(['get_workspaces', 'create_workspace']);
  });

  it('says when nothing matches, without an error', () => {
    const result = searchOperationsResult({ query: 'spaceship' }, all);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe('No operation matches "spaceship". Search in other words, or list a category with an empty query: templates, documents, workspaces, forms, pdf, einvoice, status.');
  });

  it.each([
    [{ query: 5 }, 'Error: query must be text.'],
    [{ query: 'pdf', category: 'invoices' }, 'Error: category must be one of: templates, documents, workspaces, forms, pdf, einvoice, status.'],
    [{ query: 'pdf', limit: 2.5 }, 'Error: limit must be a whole number from 1 to 25.'],
    [{ query: 'pdf', limit: '3' }, 'Error: limit must be a whole number from 1 to 25.'],
  ])('refuses %j', (args, message) => {
    const result = searchOperationsResult(args, all);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(message);
  });
});

describe('describe_operation', () => {
  it('returns the description, the whole input schema, example arguments and the tool that runs it', () => {
    const result = describeOperationsResult({ ids: ['delete_template'] }, all);
    const definition = operation('delete_template').definition;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual([{
      id: 'delete_template',
      title: 'Delete Template',
      category: 'templates',
      runWith: 'call_operation',
      description: definition.description,
      inputSchema: definition.inputSchema,
      example: { templateId: 1 },
    }]);
  });

  it('describes each operation once, in the order asked', () => {
    const described = JSON.parse(textOf(describeOperationsResult({ ids: ['get_status', 'get_templates', 'get_status'] }, all)));

    expect(described.map((entry: { id: string }) => entry.id)).toEqual(['get_status', 'get_templates']);
  });

  it('says which IDs are unknown or not granted, next to the ones it describes', () => {
    const granted = grantedOperations(['templates:read'], 'enforce');
    const result = describeOperationsResult({ ids: ['get_template', 'delete_template', 'make_coffee'] }, granted);
    const described = JSON.parse(textOf(result));

    expect(result.isError).toBeFalsy();
    expect(described[0].id).toBe('get_template');
    expect(described[0].inputSchema).toBeDefined();
    expect(described.slice(1)).toEqual([
      { id: 'delete_template', error: 'This connection is not allowed to run "delete_template". It needs the "templates:delete" permission; reconnect and grant it.' },
      { id: 'make_coffee', error: 'There is no operation "make_coffee". Find one with search_operations.' },
    ]);
  });

  it('is an error when it could describe none of them', () => {
    expect(describeOperationsResult({ ids: ['make_coffee'] }, all).isError).toBe(true);
  });

  it.each([
    [{}],
    [{ ids: [] }],
    [{ ids: 'get_status' }],
    [{ ids: [1] }],
  ])('refuses %j', (args) => {
    const result = describeOperationsResult(args, all);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: ids must list the IDs of operations, from search_operations.');
  });

  it('describes at most 5 operations at a time', () => {
    const result = describeOperationsResult({ ids: ['get_status', 'get_templates', 'get_template', 'get_forms', 'get_form', 'get_workspaces'] }, all);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Error: Describe at most 5 operations at a time.');
  });

  it('counts an ID asked for twice once', () => {
    const ids = ['get_status', 'get_templates', 'get_template', 'get_forms', 'get_form', 'get_status'];

    expect(JSON.parse(textOf(describeOperationsResult({ ids }, all)))).toHaveLength(5);
  });
});

describe('resolveRun', () => {
  it('runs an operation with its arguments', () => {
    expect(resolveRun(READ_OPERATION, { id: 'get_template', arguments: { templateId: 7 } }))
      .toEqual({ operation: operation('get_template'), args: { templateId: 7 } });
    expect(resolveRun(CALL_OPERATION, { id: 'delete_template', arguments: { templateId: 7 } }))
      .toEqual({ operation: operation('delete_template'), args: { templateId: 7 } });
  });

  it('runs an operation without arguments on none', () => {
    expect(resolveRun(READ_OPERATION, { id: 'get_status' })).toEqual({ operation: operation('get_status'), args: {} });
  });

  it.each([
    [READ_OPERATION, { id: 'delete_template' }, 'wrong_run_tool', '"delete_template" changes data, so run it with call_operation.'],
    [CALL_OPERATION, { id: 'get_templates' }, 'wrong_run_tool', '"get_templates" only reads, so run it with read_operation.'],
    [READ_OPERATION, { id: 'run_builder_tool', arguments: { template_id: 7, tool: 'add_component' } }, 'wrong_run_tool', '"run_builder_tool" changes data, so run it with call_operation.'],
    [CALL_OPERATION, { id: 'run_builder_tool', arguments: { template_id: 7, tool: 'list_pages' } }, 'wrong_run_tool', '"run_builder_tool" only reads, so run it with read_operation.'],
    [CALL_OPERATION, { id: 'make_coffee' }, 'unknown_operation', 'There is no operation "make_coffee". Find one with search_operations.'],
    [CALL_OPERATION, {}, 'invalid_arguments', 'Give the ID of an operation, from search_operations.'],
    [CALL_OPERATION, { id: '' }, 'invalid_arguments', 'Give the ID of an operation, from search_operations.'],
    [READ_OPERATION, { id: 'get_template', arguments: [7] }, 'invalid_arguments', 'arguments must be an object, as describe_operation shows for "get_template".'],
    [READ_OPERATION, { id: 'get_template', arguments: null }, 'invalid_arguments', 'arguments must be an object, as describe_operation shows for "get_template".'],
  ])('%s refuses %j', (tool, args, refusal, message) => {
    expect(resolveRun(tool, args)).toEqual({ refusal, message });
  });

  it('runs a builder tool that only reads with read_operation, and one that changes the template with call_operation', () => {
    expect(resolveRun(READ_OPERATION, { id: 'run_builder_tool', arguments: { template_id: 7, tool: 'list_pages' } }))
      .toMatchObject({ operation: operation('run_builder_tool') });
    expect(resolveRun(CALL_OPERATION, { id: 'run_builder_tool', arguments: { template_id: 7, tool: 'add_component' } }))
      .toMatchObject({ operation: operation('run_builder_tool') });
  });
});

describe('exampleArguments', () => {
  it('fills only the required fields, with the example, the default or the first allowed value', () => {
    expect(exampleArguments({
      type: 'object',
      properties: {
        a: { type: 'string', example: 'Invoice' },
        b: { type: 'string', default: 'url' },
        c: { type: 'string', enum: ['', 'pdf', 'html'] },
        d: { type: 'string' },
      },
      required: ['a', 'b', 'c'],
    })).toEqual({ a: 'Invoice', b: 'url', c: 'pdf' });
  });

  it('puts a placeholder where a schema gives no value', () => {
    expect(exampleArguments({
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'integer' }, draft: { type: 'boolean' } },
      required: ['name', 'count', 'draft', 'undeclared'],
    })).toEqual({ name: '<name>', count: 1, draft: false, undeclared: '<undeclared>' });
  });

  it('keeps numbers within their bounds', () => {
    expect(exampleArguments({
      type: 'object',
      properties: {
        width: { type: 'number', exclusiveMinimum: 0 },
        pages: { type: 'integer', exclusiveMinimum: 2.5 },
        scale: { type: 'number', minimum: 0.05 },
        older: { type: 'integer', minimum: 3, exclusiveMinimum: true },
      },
      required: ['width', 'pages', 'scale', 'older'],
    })).toEqual({ width: 1, pages: 3, scale: 0.05, older: 4 });
  });

  it('takes the first option of a union, merges an allOf and goes into nested objects', () => {
    expect(exampleArguments({
      type: 'object',
      properties: {
        requestBody: {
          oneOf: [
            { type: 'object', properties: { file_url: { type: 'string' } }, required: ['file_url'] },
            { type: 'object', properties: { file_base64: { type: 'string' } }, required: ['file_base64'] },
          ],
        },
        options: {
          allOf: [
            { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] },
          ],
        },
      },
      required: ['requestBody', 'options'],
    })).toEqual({ requestBody: { file_url: '<file_url>' }, options: { a: 1, b: false } });
  });

  it('puts one item in an array that needs one, and none otherwise', () => {
    expect(exampleArguments({
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['ids', 'tags'],
    })).toEqual({ ids: [1], tags: [] });
  });

  it('takes a nullable type as the type it is otherwise', () => {
    expect(exampleArguments({ type: 'object', properties: { note: { type: ['null', 'string'] } }, required: ['note'] }))
      .toEqual({ note: '<note>' });
  });

  it('gives an empty object for a schema that is not an object', () => {
    expect(exampleArguments({ type: 'string' })).toEqual({});
  });

  /** An example the operation turns down would cost the client a failed call. */
  it.each(all.map(item => [item.id]))('gives %s arguments its schema accepts', async (id) => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') });
    const { definition } = operation(id);
    const result = await executeApiTool(id, definition, exampleArguments(definition.inputSchema));

    expect(textOf(result)).not.toMatch(/^Invalid arguments/);
  });
});

describe('the server', () => {
  it('lists the four meta-tools first', async () => {
    const { tools } = await (await connectedClient()).listTools();

    expect(tools.slice(0, 4).map(tool => tool.name)).toEqual([SEARCH_OPERATIONS, DESCRIBE_OPERATION, READ_OPERATION, CALL_OPERATION]);
    expect(tools.find(tool => tool.name === CALL_OPERATION)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('searches and describes without calling the API', async () => {
    const client = await connectedClient();
    const found = await client.callTool({ name: SEARCH_OPERATIONS, arguments: { query: 'qr code' } });
    const described = await client.callTool({ name: DESCRIBE_OPERATION, arguments: { ids: ['generate_qr_code'] } });

    expect(textOf(found as any)).toContain('generate_qr_code | Generate QR Code | pdf | call_operation');
    expect(JSON.parse(textOf(described as any))[0].id).toBe('generate_qr_code');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('runs an operation through read_operation as the operation itself', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":{"id":7}}') });
    const client = await connectedClient();

    const result = await client.callTool({ name: READ_OPERATION, arguments: { id: 'get_template', arguments: { templateId: 7 } } });

    expect(result.isError).toBeFalsy();
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: `${API_BASE_URL}/templates/7`,
      headers: expect.objectContaining({ authorization: 'Bearer upstream-token' }),
    }));
  });

  it('runs an operation through call_operation', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') });
    const client = await connectedClient();

    await client.callTool({ name: CALL_OPERATION, arguments: { id: 'delete_template', arguments: { templateId: 7 } } });

    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', url: `${API_BASE_URL}/templates/7` }));
  });

  it('validates the arguments against the operation\'s schema', async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: READ_OPERATION, arguments: { id: 'get_template', arguments: { templateId: 'seven' } } });

    expect(result.isError).toBe(true);
    expect(textOf(result as any)).toMatch(/^Invalid arguments for tool 'get_template': templateId/);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('refuses a run with the wrong tool before calling the API', async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: READ_OPERATION, arguments: { id: 'delete_template', arguments: { templateId: 7 } } });

    expect(result.isError).toBe(true);
    expect(textOf(result as any)).toBe('Error: "delete_template" changes data, so run it with call_operation.');
    expect(mockAxios).not.toHaveBeenCalled();
  });
});
