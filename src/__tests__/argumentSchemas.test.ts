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

  it.each(['create_template', 'update_template', 'validate_template'])('lets %s give a page a background colour', async (tool) => {
    const result = await run(tool, { templateId: 1, requestBody: { name: 'Flyer', pages: [{ components: [], backgroundColor: '#336699' }] } });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data.pages[0].backgroundColor).toBe('#336699');
  });

  it.each(['#33669980', '#3698', 'rgb(51, 102, 153)', 'rgba(51, 102, 153, 0.5)'])(
    'lets a page background colour carry an alpha, as %s',
    async (color) => {
      const result = await run('create_template', { requestBody: { name: 'Flyer', pages: [{ components: [], backgroundColor: color }] } });

      expect(result.isError).toBeFalsy();
      expect((mockAxios.mock.calls[0][0] as any).data.pages[0].backgroundColor).toBe(color);
    }
  );

  it.each(['#12345', 'rgba(51, 102)'])('refuses %s as a page background colour', async (color) => {
    const result = await run('create_template', { requestBody: { name: 'Flyer', pages: [{ components: [], backgroundColor: color }] } });

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('refuses a page background colour that is not hex', async () => {
    const result = await run('create_template', { requestBody: { name: 'Flyer', pages: [{ components: [], backgroundColor: 'red' }] } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.pages.0.backgroundColor');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(['create_template', 'update_template', 'validate_template'])('lets %s say how a page background image fits the page', async (tool) => {
    const result = await run(tool, { templateId: 1, requestBody: { name: 'Flyer', pages: [{ components: [], backgroundImage: 'https://example.com/bg.svg', backgroundImageFit: 'contain' }] } });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data.pages[0].backgroundImageFit).toBe('contain');
  });

  // get_template answers null for a page with no fit, and a client sends the page back as it got it.
  it.each(['create_template', 'update_template', 'validate_template'])('lets %s send a page background image fit of null', async (tool) => {
    const result = await run(tool, { templateId: 1, requestBody: { name: 'Flyer', pages: [{ components: [], backgroundImage: 'https://example.com/bg.svg', backgroundImageFit: null }] } });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data.pages[0].backgroundImageFit).toBeNull();
  });

  it.each(['create_template', 'update_template', 'validate_template'])('refuses a page background image fit in %s that is not one of the three', async (tool) => {
    const result = await run(tool, { templateId: 1, requestBody: { name: 'Flyer', pages: [{ components: [], backgroundImageFit: 'tile' }] } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.pages.0.backgroundImageFit');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([['Japanese', 'ja'], ['Portuguese', 'pt']])('lets open_editor open the editor in %s', async (_, language) => {
    const result = await run('open_editor', { templateId: 58057, requestBody: { data: { name: 'Alex' }, language } });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data.language).toBe(language);
  });

  it('refuses an editor language the editor does not have', async () => {
    const result = await run('open_editor', { templateId: 58057, requestBody: { data: { name: 'Alex' }, language: 'xx' } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.language');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('sends a URL to PDF conversion with only the URL, for the API to fill in its defaults', async () => {
    const result = await run('convert_url_to_pdf', { requestBody: { url: 'https://example.test/report' } });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data).toEqual({ url: 'https://example.test/report' });
  });

  it.each([
    ['generate_document_async', { template: { id: 58057, data: {} } }],
    ['generate_document_batch_async', { template: [{ id: 58057, data: {} }] }],
  ])('refuses %s without the callback the API requires', async (tool, requestBody) => {
    const result = await run(tool, { requestBody });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.callback');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([
    ['get_templates', { search: 'Invoice', order_by: 'name', order_direction: 'asc' }],
    ['get_workspaces', { search: 'demo', order_by: 'identifier', order_direction: 'asc', activated: 1 }],
    ['get_documents', { search: 'Invoice', format: 'pdf' }],
  ])('sends the search, sort and filters of %s to the API', async (tool, args) => {
    const result = await run(tool, args);

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).params).toEqual(args);
  });

  it.each([
    ['a public template id', { template: { id: 'ff3b3a3b9e8e', data: {} } }],
    ['data from a URL', { template: { id: 58057, data: 'https://example.test/data.json' } }],
    ['attachments, print and empty labels', {
      template: { id: 58057, data: {} },
      attachments: [{ name: 'invoice.xml', content: 'PD94bWw+' }],
      print: true,
      empty_labels: 2,
    }],
  ])('lets generate_document send %s', async (_, requestBody) => {
    const result = await run('generate_document', { requestBody });

    expect(result.isError).toBeFalsy();
    expect((mockAxios.mock.calls[0][0] as any).data).toEqual(requestBody);
  });

  it.each(['xlsx', 'zip'])('refuses the deprecated %s format before it reaches the API', async (format) => {
    const result = await run('generate_document', { requestBody: { template: { id: 58057, data: {} }, format } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('requestBody.format');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(['url', 'viewer'])('lets make_accessible answer with a %s', async (output) => {
    const result = await run('make_accessible', { requestBody: { file_url: 'https://example.test/a.pdf', output, options: ['add_tags'] } });

    expect(result.isError).toBeFalsy();
  });

  it('refuses a make_accessible option the API does not have', async () => {
    const result = await run('make_accessible', { requestBody: { file_url: 'https://example.test/a.pdf', options: ['make_it_nice'] } });

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('lets create_einvoice make an XRechnung', async () => {
    const result = await run('create_einvoice', { requestBody: { type: 'XRECHNUNG-UBL', data: {} } });

    expect((result.content[0] as { text: string }).text).not.toContain('requestBody.type');
  });

  it.each([
    ['a template name longer than 120 characters', 'create_template', { name: 'x'.repeat(121) }],
    ['a callback URL that is not https', 'generate_document_async', {
      template: { id: 58057, data: {} },
      callback: { url: 'http://example.test/callback' },
    }],
  ])('refuses %s before it reaches the API', async (_, tool, requestBody) => {
    const result = await run(tool, { requestBody });

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });
});
