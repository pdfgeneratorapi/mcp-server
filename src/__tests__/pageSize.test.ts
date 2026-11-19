import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { catalogue } = await import('../catalogue.js');
const { operations } = await import('../operations.js');
const { executeApiTool } = await import('../execute.js');

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

beforeEach(() => {
  mockAxios.mockReset();
  mockAxios.mockResolvedValue(answer({ response: [], meta: {} }));
});

describe('the list operations', () => {
  it('are the operations that take a page size', () => {
    const paged = [...catalogue.values()].filter(definition => definition.inputSchema.properties?.per_page).map(definition => definition.name);

    expect(paged.sort()).toEqual([...LIST_OPERATIONS].sort());
  });

  it.each(LIST_OPERATIONS)('%s takes a page size of 1 to 10, 10 when left out', (id) => {
    expect(operations.get(id)!.definition.inputSchema.properties.per_page).toEqual(
      expect.objectContaining({ type: 'integer', minimum: 1, maximum: 10, default: 10 }),
    );
  });

  it('ask the API for 10 records a page when the call leaves the page size out', async () => {
    await call('get_templates', { page: 2 });

    expect(sentParams()).toEqual({ page: 2, per_page: 10 });
  });

  it('ask the API for the page size the call gives', async () => {
    await call('get_documents', { per_page: 4 });

    expect(sentParams()).toEqual({ per_page: 4 });
  });

  it('ask for 10 a page on a path with an ID too', async () => {
    await call('list_template_versions', { templateId: 42 });

    expect(sentParams()).toEqual({ per_page: 10 });
    expect((mockAxios.mock.calls[0][0] as { url: string }).url).toBe('https://test-api.example.com/api/v4/templates/42/versions');
  });

  it.each([11, 100, 0, -1, 2.5])('refuse a page size of %p before it reaches the API', async (size) => {
    const result = await call('get_templates', { per_page: size });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('per_page');
    expect(mockAxios).not.toHaveBeenCalled();
  });
});

describe('the other operations', () => {
  it('send no page size', async () => {
    await call('get_template', { templateId: 42 });

    expect(sentParams()).toEqual({});
  });

  it('carry no page size defaults', () => {
    const others = [...catalogue.values()].filter(definition => !LIST_OPERATIONS.includes(definition.name));

    expect(others.filter(definition => definition.queryDefaults)).toEqual([]);
  });
});
