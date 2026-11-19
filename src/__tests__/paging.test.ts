import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { catalogue } = await import('../catalogue.js');
const { operations } = await import('../operations.js');
const { executeApiTool } = await import('../execute.js');
const { toolDefinitionMap } = await import('../tools.js');

const LIST_OPERATIONS = ['get_templates', 'list_template_versions', 'get_documents', 'get_workspaces', 'get_forms'];

function answer(body: unknown) {
  return { status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from(JSON.stringify(body)) };
}

function call(tool: string, args: Record<string, unknown>) {
  return executeApiTool(tool, catalogue.get(tool)!, args);
}

function sentParams(): Record<string, unknown> {
  return (mockAxios.mock.calls[0][0] as { params: Record<string, unknown> }).params;
}

function textOf(result: any): string {
  return (result.content[0] as { text: string }).text;
}

beforeEach(() => {
  mockAxios.mockReset();
  mockAxios.mockResolvedValue(answer({ response: [], meta: {} }));
});

describe('the list operations', () => {
  it('are the operations that take a page size and a page', () => {
    const paged = (field: string) => [...catalogue.values()].filter(definition => definition.inputSchema.properties?.[field]).map(definition => definition.name).sort();

    expect(paged('per_page')).toEqual([...LIST_OPERATIONS].sort());
    expect(paged('page')).toEqual([...LIST_OPERATIONS].sort());
  });

  it.each(LIST_OPERATIONS)('%s takes a page size of 1 to 50 and a page from 1, both whole numbers', (id) => {
    const { per_page: pageSize, page } = operations.get(id)!.definition.inputSchema.properties;

    expect(pageSize).toEqual(expect.objectContaining({ type: 'integer', minimum: 1, maximum: 50 }));
    expect(page).toEqual(expect.objectContaining({ type: 'integer', minimum: 1 }));
  });

  it.each(LIST_OPERATIONS)('%s keeps the description and default the spec gives', (id) => {
    const generated = toolDefinitionMap.get(id)!.inputSchema.properties;
    const { per_page: pageSize, page } = operations.get(id)!.definition.inputSchema.properties;

    expect(pageSize.description).toBe(generated.per_page.description);
    expect(pageSize.default).toBe(generated.per_page.default);
    expect(page.description).toBe(generated.page.description);
    expect(page.default).toBe(generated.page.default);
  });

  it('send the page and page size the call gives', async () => {
    await call('get_templates', { page: 3, per_page: 50 });

    expect(sentParams()).toEqual({ page: 3, per_page: 50 });
  });

  it('leave the page size to the API when the call leaves it out', async () => {
    await call('get_documents', { page: 2 });

    expect(sentParams()).toEqual({ page: 2 });
  });

  it('page on a path with an ID too', async () => {
    await call('list_template_versions', { templateId: 42, page: 2, per_page: 20 });

    expect(sentParams()).toEqual({ page: 2, per_page: 20 });
    expect((mockAxios.mock.calls[0][0] as { url: string }).url).toBe('https://test-api.example.com/api/v4/templates/42/versions');
  });

  it.each([51, 100, 0, -1, 2.5])('refuse a page size of %p before it reaches the API', async (size) => {
    const result = await call('get_templates', { per_page: size });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('per_page');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5])('refuse a page of %p before it reaches the API', async (page) => {
    const result = await call('get_workspaces', { page });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('page');
    expect(mockAxios).not.toHaveBeenCalled();
  });
});

describe('the other operations', () => {
  it('are left as the spec gives them', () => {
    const others = [...toolDefinitionMap.keys()].filter(id => !LIST_OPERATIONS.includes(id));

    for (const id of others) {
      const properties = catalogue.get(id)!.inputSchema.properties ?? {};
      expect([id, properties.per_page, properties.page]).toEqual([id, undefined, undefined]);
    }
  });

  it('send no page or page size', async () => {
    await call('get_template', { templateId: 42 });

    expect(sentParams()).toEqual({});
  });
});
