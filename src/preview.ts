/**
 * Page images: a client sees pages of a template in the chat, as images, in one call, to check
 * how a template looks while building it.
 */
import type { McpToolDefinition } from './types.js';

export const PREVIEW_TEMPLATE = 'preview_template';

const MAX_PAGES = 3;

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
            pages: {
              type: 'string',
              pattern: '^\\d+(-\\d+)?$',
              default: '1',
              description: `One page, such as "2", or a range of up to ${MAX_PAGES} pages, such as "1-3".`,
            },
            resolution: {
              type: 'integer',
              minimum: 72,
              maximum: 150,
              default: 100,
              description: 'Resolution of the images, in DPI. A higher one shows more detail and costs more context.',
            },
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
]);
