import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { executeApiTool } = await import('../execute.js');
const { catalogue } = await import('../catalogue.js');

const ok = { status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":{}}') };
const SCHEMA_FAILURE = 'Failed to generate/evaluate Zod schema';

let output: string[] = [];

beforeEach(() => {
  output = [];
  mockAxios.mockResolvedValue(ok);
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  mockAxios.mockReset();
});

function run(tool: string, args: Record<string, unknown>) {
  return executeApiTool(tool, catalogue.get(tool)!, args, undefined);
}

describe('tool argument schemas', () => {
  it.each([...catalogue.keys()])('builds the argument schema of %s', async (tool) => {
    await run(tool, {});

    expect(output.filter(line => line.includes(SCHEMA_FAILURE))).toEqual([]);
  });

  /**
   * A body that is one of several shapes (a file by URL or as base64) is where the schema used to
   * fail to build, which let any arguments through to the API.
   */
  it('refuses a wrong argument type in a body that is one of several shapes', async () => {
    const result = await run('encrypt_document', { requestBody: { file_url: 42, owner_password: 'secret' } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid arguments for tool 'encrypt_document'");
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([
    [{ file_url: 'https://example.test/a.pdf', owner_password: 'secret' }],
    [{ file_base64: 'JVBERi0=', owner_password: 'secret' }],
  ])('accepts each of the shapes: %o', async (requestBody) => {
    const result = await run('encrypt_document', { requestBody });

    expect(result.isError).toBeFalsy();
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(requestBody) }));
  });

  it.each([
    ['generate_document', { requestBody: { template: { id: 58057, data: { name: 'Alex' } }, format: 'pdf', output: 'url' } }],
    ['generate_document', { requestBody: { template: { id: 58057, data: [{ name: 'Alex' }, { name: 'Sam' }] }, output: 'url' } }],
    ['open_editor', { templateId: 58057, requestBody: { data: { name: 'Alex' } } }],
    ['open_editor', { templateId: 58057, requestBody: { data: [{ name: 'Alex' }] } }],
    ['convert_url_to_pdf', { requestBody: { url: 'https://example.test/report', wait_for_css: '#report-ready', wait_timeout: 10, on_wait_timeout: 'print' } }],
    ['create_form', { requestBody: {
      name: 'Order',
      actions: [{ store_document: true }],
      fields: [{ label: 'Size', name: 'size', type: 'select', required: true, default: 'Medium', subRows: [{ options: 'Small,Medium,Large' }] }],
    } }],
    ['get_forms', { search: 'Certificate', order_by: 'name', order_direction: 'asc' }],
  ])('lets a usual %s call through', async (tool, args) => {
    const result = await run(tool, args);

    expect(result.isError).toBeFalsy();
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  const margins = { top: 1, right: 1, bottom: 1, left: 1 };

  it.each([
    ['A3', { format: 'A3', orientation: 'landscape', margins }],
    ['a custom size', { format: 'custom', width: 10, height: 15, orientation: 'portrait', margins }],
  ])('lets a template layout in %s through', async (_, layout) => {
    const result = await run('create_template', { requestBody: { name: 'Poster', layout } });

    expect(result.isError).toBeFalsy();
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('refuses a template layout without the margins the API requires', async () => {
    const result = await run('validate_template', { requestBody: { name: 'Poster', layout: { format: 'A4', orientation: 'portrait' } } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.layout.margins');
    expect(mockAxios).not.toHaveBeenCalled();
  });
});
