import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { catalogue } = await import('../catalogue.js');
const { executeApiTool, FULL_RESPONSE_ARGUMENT } = await import('../execute.js');
const { summarizeTemplateResponse } = await import('../templateSummary.js');

const WRITE_TOOLS = ['create_template', 'update_template', 'copy_template', 'import_template'];

const image = { type: 'image', value: `data:image/png;base64,${'A'.repeat(20_000)}` };
const savedTemplate = {
  id: 42,
  name: 'Invoice',
  tags: ['billing'],
  isDraft: false,
  layout: { format: 'A4', unit: 'cm' },
  pages: [
    {
      width: 21,
      height: 29.7,
      components: [
        { type: 'pageHeader', components: [image, { type: 'text', value: 'Invoice' }] },
        { type: 'composite', components: [{ type: 'text', value: 'Total' }] },
        image,
      ],
    },
    { width: 21, height: 29.7, components: [image] },
  ],
  dataSettings: { sortBy: [], filterBy: [] },
  editor: { heightMultiplier: 1 },
  fontSubsetting: false,
  barcodeAsImage: false,
  improvedHtmlSpacing: false,
  backgroundPdf: null,
};

function answer(body: unknown, status = 200) {
  return { status, headers: { 'content-type': 'application/json' }, data: Buffer.from(JSON.stringify(body)) };
}

function call(tool: string, args: Record<string, unknown>) {
  return executeApiTool(tool, catalogue.get(tool)!, args);
}

function text(result: any): string {
  return result.content[0].text;
}

function jsonOf(result: any): any {
  return JSON.parse(text(result).slice(text(result).indexOf('\n') + 1));
}

beforeEach(() => {
  mockAxios.mockReset();
});

describe('the template write tools', () => {
  it('answer with a summary of the saved template by default', async () => {
    mockAxios.mockResolvedValue(answer({ response: savedTemplate, meta: {} }));

    const result = await call('update_template', { templateId: 42, requestBody: { name: 'Invoice' } });

    expect(result.isError).toBeUndefined();
    expect(text(result).length).toBeLessThan(1_000);
    expect(text(result)).toContain(`set ${FULL_RESPONSE_ARGUMENT} to true`);
    expect(jsonOf(result)).toEqual({
      response: {
        id: 42,
        name: 'Invoice',
        tags: ['billing'],
        isDraft: false,
        fontSubsetting: false,
        barcodeAsImage: false,
        improvedHtmlSpacing: false,
        pageCount: 2,
        componentCount: 7,
      },
      meta: {},
    });
  });

  it('answer with the whole template when the call asks for it', async () => {
    mockAxios.mockResolvedValue(answer({ response: savedTemplate, meta: {} }, 201));

    const result = await call('create_template', { requestBody: { name: 'Invoice' }, [FULL_RESPONSE_ARGUMENT]: true });

    expect(text(result)).toMatch(/^API Response \(Status: 201\):\n/);
    expect(jsonOf(result)).toEqual({ response: savedTemplate, meta: {} });
  });

  it('do not send the opt-in to the API', async () => {
    mockAxios.mockResolvedValue(answer({ response: savedTemplate, meta: {} }));

    await call('update_template', { templateId: 42, requestBody: { name: 'Invoice' }, [FULL_RESPONSE_ARGUMENT]: true });

    const sent = mockAxios.mock.calls[0][0] as { params: unknown; data: unknown; url: string };
    expect(sent.params).toEqual({});
    expect(sent.data).not.toHaveProperty(FULL_RESPONSE_ARGUMENT);
    expect(sent.url).toBe('https://test-api.example.com/api/v4/templates/42');
  });

  it('keep what the API reports next to the template', async () => {
    const warning = { component: 'pages[0].components[2]', field: 'borderWidth', given: 0.75, stored: 0 };
    mockAxios.mockResolvedValue(answer({ response: { ...savedTemplate, warnings: [warning] }, meta: { warnings: [warning] } }));

    const summary = jsonOf(await call('update_template', { templateId: 42, requestBody: { name: 'Invoice' } }));

    expect(summary.response.warnings).toEqual([warning]);
    expect(summary.meta.warnings).toEqual([warning]);
  });

  it('refuse an opt-in that is not a boolean', async () => {
    const result = await call('update_template', { templateId: 42, requestBody: { name: 'Invoice' }, [FULL_RESPONSE_ARGUMENT]: 'yes' });

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(WRITE_TOOLS)('%s advertises the opt-in', (tool) => {
    const definition = catalogue.get(tool)!;

    expect(definition.inputSchema.properties[FULL_RESPONSE_ARGUMENT]).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(definition.description).toContain(FULL_RESPONSE_ARGUMENT);
  });

  it('leave the other tools as they are', async () => {
    const others = [...catalogue.values()].filter(definition => !WRITE_TOOLS.includes(definition.name));

    expect(others.filter(definition => definition.summarizeResponse || definition.inputSchema.properties?.[FULL_RESPONSE_ARGUMENT])).toEqual([]);

    mockAxios.mockResolvedValue(answer({ response: savedTemplate, meta: {} }));
    expect(jsonOf(await call('get_template', { templateId: 42 }))).toEqual({ response: savedTemplate, meta: {} });
  });
});

describe('summarizeTemplateResponse', () => {
  it.each([
    ['no template', { message: 'Template not found' }],
    ['a template that is not an object', { response: 'saved' }],
    ['a list', { response: [savedTemplate] }],
  ])('leaves a body with %s unchanged', (_case, body) => {
    expect(summarizeTemplateResponse(body)).toEqual(body);
  });

  it('counts a template without pages as empty', () => {
    expect(summarizeTemplateResponse({ response: { id: 1, name: 'Empty' } })).toEqual({
      response: { id: 1, name: 'Empty', pageCount: 0, componentCount: 0 },
    });
  });
});
