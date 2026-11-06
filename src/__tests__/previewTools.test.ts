import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { API_BASE_URL } = await import('../config.js');
const { previewToolDefinitionMap, PREVIEW_TEMPLATE, SHOW_PDF_PAGES } = await import('../preview.js');
const { catalogue } = await import('../catalogue.js');
const { executeApiTool } = await import('../execute.js');
const { mayCallTool, visibleTools } = await import('../auth/scopes.js');
const { readZip } = await import('../zip.js');

const auth = { getToken: async () => 'upstream-token', invalidate: () => {} };
const previewTemplate = previewToolDefinitionMap.get(PREVIEW_TEMPLATE)!;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('a page')]);

function answer(contentType: string, body: Buffer) {
  return { status: 200, headers: { 'content-type': contentType }, data: body };
}

beforeEach(() => {
  mockAxios.mockReset();
});

describe('preview_template', () => {
  it('is in the catalogue', () => {
    expect(catalogue.get(PREVIEW_TEMPLATE)).toBe(previewTemplate);
  });

  it('posts the template to the preview route of the API', async () => {
    mockAxios.mockResolvedValue(answer('image/png', png));
    const requestBody = { template: { id: 42, version_id: 7, data: { total: 3 } }, pages: '2', resolution: 120 };

    await executeApiTool(PREVIEW_TEMPLATE, previewTemplate, { requestBody }, auth);

    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: `${API_BASE_URL}/documents/preview`,
      data: requestBody,
      headers: expect.objectContaining({ authorization: 'Bearer upstream-token' }),
    }));
  });

  it('previews a template that is not saved', async () => {
    mockAxios.mockResolvedValue(answer('image/png', png));
    const definition = { name: 'Invoice', layout: { format: 'A4' }, pages: [{ components: [] }] };

    await executeApiTool(PREVIEW_TEMPLATE, previewTemplate, { requestBody: { template: { definition } } }, auth);

    expect((mockAxios.mock.calls[0][0] as any).data).toEqual({ template: { definition } });
  });

  it('shows one page as an image', async () => {
    mockAxios.mockResolvedValue(answer('image/png', png));

    const result = await executeApiTool(PREVIEW_TEMPLATE, previewTemplate, { requestBody: { template: { id: 42 } } }, auth);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([
      { type: 'text', text: 'API Response (Status: 200): 1 image' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
  });

  it('shows a range as one image per page, in order', async () => {
    const zip = readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/pdf-services-pages.zip'));
    mockAxios.mockResolvedValue(answer('application/zip', zip));

    const result = await executeApiTool(
      PREVIEW_TEMPLATE,
      previewTemplate,
      { requestBody: { template: { id: 42 }, pages: '1-2' } },
      auth,
    );

    expect(result.content).toEqual([
      { type: 'text', text: 'API Response (Status: 200): 2 images' },
      ...readZip(zip).map(page => ({ type: 'image', data: page.data.toString('base64'), mimeType: 'image/png' })),
    ]);
  });

  it.each([
    ['without a template', {}],
    ['for pages that are neither a page nor a range', { template: { id: 42 }, pages: 'all' }],
    ['above 150 DPI', { template: { id: 42 }, resolution: 300 }],
    ['below 72 DPI', { template: { id: 42 }, resolution: 50 }],
  ])('refuses a preview %s before it reaches the API', async (_case, requestBody) => {
    const result = await executeApiTool(PREVIEW_TEMPLATE, previewTemplate, { requestBody }, auth);

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('passes on what the API refuses', async () => {
    mockAxios.mockRejectedValue(Object.assign(new Error('Request failed with status code 422'), {
      isAxiosError: true,
      response: {
        status: 422,
        statusText: 'Unprocessable Content',
        headers: { 'content-type': 'application/json' },
        data: Buffer.from(JSON.stringify({ errors: { pages: ['The pages field goes past page 1, the last page of the document.'] } })),
      },
      config: {},
    }));

    const result = await executeApiTool(
      PREVIEW_TEMPLATE,
      previewTemplate,
      { requestBody: { template: { id: 42 }, pages: '2' } },
      auth,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('The pages field goes past page 1');
  });

  it('needs the permission to generate documents', () => {
    expect(mayCallTool(PREVIEW_TEMPLATE, ['templates:read'], {})).toEqual({ allowed: false, required: 'documents:write' });
    expect(mayCallTool(PREVIEW_TEMPLATE, ['documents:write'], {}).allowed).toBe(true);
    expect(visibleTools(['documents:write'])).toContain(PREVIEW_TEMPLATE);
    expect(visibleTools(['templates:read'])).not.toContain(PREVIEW_TEMPLATE);
  });
});

describe('show_pdf_pages', () => {
  const showPdfPages = previewToolDefinitionMap.get(SHOW_PDF_PAGES)!;
  const zip = () => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/pdf-services-pages.zip'));
  const fileUrl = 'https://example.org/invoice.pdf';

  it('is in the catalogue', () => {
    expect(catalogue.get(SHOW_PDF_PAGES)).toBe(showPdfPages);
  });

  it('asks the PDF to image conversion for PNG pages in a zip', async () => {
    mockAxios.mockResolvedValue(answer('application/zip', zip()));

    await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_url: fileUrl, pages: '2-3', resolution: 120 } }, auth);

    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: `${API_BASE_URL}/conversion/pdf2image`,
      data: { file_url: fileUrl, pages: '2-3', resolution: 120, format: 'png', output: 'file' },
    }));
  });

  it('shows the first page at 100 DPI when the call names neither', async () => {
    mockAxios.mockResolvedValue(answer('application/zip', zip()));
    const fileBase64 = Buffer.from('%PDF-1.7').toString('base64');

    await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_base64: fileBase64 } }, auth);

    expect((mockAxios.mock.calls[0][0] as any).data)
      .toEqual({ file_base64: fileBase64, pages: '1', resolution: 100, format: 'png', output: 'file' });
  });

  it('always asks for PNG pages in a zip, whatever the call sends', async () => {
    mockAxios.mockResolvedValue(answer('application/zip', zip()));

    await executeApiTool(
      SHOW_PDF_PAGES,
      showPdfPages,
      { requestBody: { file_url: fileUrl, format: 'jpeg', output: 'base64' } },
      auth,
    );

    expect((mockAxios.mock.calls[0][0] as any).data).toEqual(expect.objectContaining({ format: 'png', output: 'file' }));
  });

  it('shows the pages as images, in order', async () => {
    mockAxios.mockResolvedValue(answer('application/zip', zip()));

    const result = await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_url: fileUrl, pages: '1-2' } }, auth);

    expect(result.content).toEqual([
      { type: 'text', text: 'API Response (Status: 200): 2 images' },
      ...readZip(zip()).map(page => ({ type: 'image', data: page.data.toString('base64'), mimeType: 'image/png' })),
    ]);
  });

  it.each([
    ['1-4', 'pages "1-4" covers 4 pages; at most 3 are shown at once.'],
    ['2-10', 'pages "2-10" covers 9 pages; at most 3 are shown at once.'],
    ['0', 'pages "0" is not a page or a range of pages, such as "2" or "1-3".'],
    ['3-1', 'pages "3-1" is not a page or a range of pages, such as "2" or "1-3".'],
  ])('refuses pages %s before it is charged for them', async (pages, reason) => {
    const result = await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_url: fileUrl, pages } }, auth);

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: `Invalid arguments for tool 'show_pdf_pages': ${reason}` }]);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each([['all'], ['1,3']])('refuses pages "%s", which is neither a page nor a range', async (pages) => {
    const result = await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_url: fileUrl, pages } }, auth);

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('refuses a resolution above 150 DPI', async () => {
    const result = await executeApiTool(SHOW_PDF_PAGES, showPdfPages, { requestBody: { file_url: fileUrl, resolution: 300 } }, auth);

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('needs the permission to convert PDFs, as convert_pdf_to_image does', () => {
    expect(mayCallTool(SHOW_PDF_PAGES, ['documents:write'], {})).toEqual({ allowed: false, required: 'pdf:write' });
    expect(mayCallTool(SHOW_PDF_PAGES, ['pdf:write'], {}).allowed).toBe(true);
  });
});
