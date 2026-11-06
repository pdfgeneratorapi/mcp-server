/**
 * Page images: a client sees pages of a template, or of a PDF, in the chat, as images, in one
 * call, to check how a template looks while building it.
 */
import type { JsonObject, McpToolDefinition } from './types.js';
import { InvalidArgumentsError } from './execute.js';

export const PREVIEW_TEMPLATE = 'preview_template';
export const SHOW_PDF_PAGES = 'show_pdf_pages';

const MAX_PAGES = 3;
const DEFAULT_PAGES = '1';
const DEFAULT_RESOLUTION = 100;

const pages = {
  type: 'string',
  pattern: '^\\d+(-\\d+)?$',
  default: DEFAULT_PAGES,
  description: `One page, such as "2", or a range of up to ${MAX_PAGES} pages, such as "1-3".`,
};

const resolution = {
  type: 'integer',
  minimum: 72,
  maximum: 150,
  default: DEFAULT_RESOLUTION,
  description: 'Resolution of the images, in DPI. A higher one shows more detail and costs more context.',
};

/**
 * The PDF to image conversion charges for every page it renders, so a range longer than the
 * pages shown is refused before it reaches the API.
 */
function pdfPagesAsImages(body: JsonObject): JsonObject {
  const range = String(body.pages ?? DEFAULT_PAGES);
  const [first, last = first] = range.split('-').map(Number);

  if (first < 1 || last < first) {
    throw new InvalidArgumentsError(`pages "${range}" is not a page or a range of pages, such as "2" or "1-3".`);
  }
  if (last - first + 1 > MAX_PAGES) {
    throw new InvalidArgumentsError(`pages "${range}" covers ${last - first + 1} pages; at most ${MAX_PAGES} are shown at once.`);
  }

  return {
    ...body,
    pages: range,
    resolution: body.resolution ?? DEFAULT_RESOLUTION,
    format: 'png',
    output: 'file',
  };
}

const templateData = {
  description: 'Data for the template\'s placeholders: an object, or an array of objects for one copy of the template each.',
  oneOf: [
    { type: 'object', description: 'Data for the template\'s placeholders.' },
    {
      type: 'array',
      description: 'Data for the template\'s placeholders, one object per document of a batch.',
      items: { type: 'object' },
    },
  ],
};

export const previewToolDefinitionMap: Map<string, McpToolDefinition> = new Map([
  [PREVIEW_TEMPLATE, {
    name: PREVIEW_TEMPLATE,
    description: `Shows up to ${MAX_PAGES} pages of a template as PNG images, to check how it looks. Give the \`id\` of a saved template, with a \`version_id\` for one of its versions, or the \`definition\` of a template not saved yet, as create_template takes it. Every page carries a PREVIEW stamp. A preview uses no credits and stores nothing.`,
    inputSchema: {
      type: 'object',
      properties: {
        requestBody: {
          type: 'object',
          properties: {
            template: {
              type: 'object',
              description: 'The template to preview: its id, or its definition.',
              properties: {
                id: { type: 'integer', description: 'ID of a saved template. Give either id or definition.' },
                version_id: { type: 'integer', description: 'A version of the saved template, previewed instead of its live version.' },
                definition: {
                  type: 'object',
                  description: 'A template that is not saved, in the shape create_template takes. Give either id or definition.',
                },
                data: templateData,
              },
            },
            pages,
            resolution,
          },
          required: ['template'],
        },
      },
      required: ['requestBody'],
    },
    method: 'post',
    pathTemplate: '/documents/preview',
    executionParameters: [],
    requestBodyContentType: 'application/json',
    imageResponse: true,
  }],
  [SHOW_PDF_PAGES, {
    name: SHOW_PDF_PAGES,
    description: `Shows up to ${MAX_PAGES} pages of a PDF as PNG images in the chat, from a public URL or base64. convert_pdf_to_image answers with a zip file instead. It is charged as a PDF to image conversion, for each page shown. It is for a PDF you already have: to look at a template, call ${PREVIEW_TEMPLATE}, which is free, instead of generating a document first.`,
    inputSchema: {
      type: 'object',
      properties: {
        requestBody: {
          type: 'object',
          properties: {
            file_url: { type: 'string', description: 'Public HTTPS URL of the PDF. Give either file_url or file_base64.' },
            file_base64: { type: 'string', description: 'The PDF, base64 encoded. Give either file_url or file_base64.' },
            pages,
            resolution,
          },
        },
      },
      required: ['requestBody'],
    },
    method: 'post',
    pathTemplate: '/conversion/pdf2image',
    executionParameters: [],
    requestBodyContentType: 'application/json',
    imageResponse: true,
    prepareRequestBody: pdfPagesAsImages,
  }],
]);
