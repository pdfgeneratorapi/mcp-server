import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { McpToolDefinition } from '../types.js';

// Mock axios before importing execute
const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => {
  const actual = jest.requireActual('axios') as any;
  const fn = Object.assign(mockAxios, {
    isAxiosError: actual.isAxiosError ?? ((e: any) => !!e.isAxiosError),
  });
  return { default: fn, __esModule: true };
});

// Import after mocking
const { executeApiTool } = await import('../execute.js');
const { toolDefinitionMap } = await import('../tools.js');

function makeTool(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: 'testTool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    method: 'get',
    pathTemplate: '/test',
    executionParameters: [],
    requestBodyContentType: undefined,
    ...overrides,
  };
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function jsonBytes(value: unknown): ArrayBuffer {
  return toArrayBuffer(Buffer.from(JSON.stringify(value)));
}

function upstreamAuth(...tokens: string[]) {
  let call = 0;

  return {
    getToken: jest.fn(async () => tokens[Math.min(call++, tokens.length - 1)]),
    invalidate: jest.fn(),
  };
}

function axiosError(status: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, statusText: '', data: {}, headers: {} },
    config: {},
  });
}

beforeEach(() => {
  mockAxios.mockReset();
});

describe('executeApiTool', () => {
  it('should make a GET request and return JSON response', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { result: 'ok' },
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect(mockAxios).toHaveBeenCalledTimes(1);
    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.method).toBe('GET');
    expect(config.url).toContain('/test');
    expect(config.timeout).toBe(30000);

    expect(result.content[0] as any).toMatchObject({
      type: 'text',
      text: expect.stringContaining('"result": "ok"'),
    });
  });

  it('should authenticate with the upstream credential', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    await executeApiTool('testTool', makeTool(), {}, upstreamAuth('upstream-token'));

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.headers.authorization).toBe('Bearer upstream-token');
  });

  it('should not set Authorization header without upstream credentials', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    await executeApiTool('testTool', makeTool(), {});

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.headers.authorization).toBeUndefined();
  });

  it('should not fetch a credential for arguments that fail validation', async () => {
    const auth = upstreamAuth('upstream-token');
    const tool = makeTool({
      inputSchema: { type: 'object', properties: { templateId: { type: 'integer' } }, required: ['templateId'] },
    });

    const result = await executeApiTool('testTool', tool, {}, auth);

    expect(result.isError).toBe(true);
    expect(auth.getToken).not.toHaveBeenCalled();
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('should retry once with a fresh credential after a 401', async () => {
    const auth = upstreamAuth('stale-token', 'fresh-token');
    mockAxios
      .mockRejectedValueOnce(axiosError(401))
      .mockResolvedValueOnce({ status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } });

    const result = await executeApiTool('testTool', makeTool(), {}, auth);

    expect(result.isError).toBeFalsy();
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect((mockAxios.mock.calls[1][0] as any).headers.authorization).toBe('Bearer fresh-token');
  });

  it('should give up after a second 401', async () => {
    const auth = upstreamAuth('stale-token', 'still-stale-token');
    mockAxios.mockRejectedValue(axiosError(401));

    const result = await executeApiTool('testTool', makeTool(), {}, auth);

    expect(result.isError).toBe(true);
    expect(mockAxios).toHaveBeenCalledTimes(2);
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
  });

  it('should not retry other errors', async () => {
    const auth = upstreamAuth('upstream-token');
    mockAxios.mockRejectedValue(axiosError(403));

    await executeApiTool('testTool', makeTool(), {}, auth);

    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect(auth.invalidate).not.toHaveBeenCalled();
  });

  it('should report a credential that cannot be obtained as a tool error', async () => {
    const auth = {
      getToken: jest.fn(async () => { throw new Error('The user belongs to several organizations.'); }),
      invalidate: jest.fn(),
    };

    const result = await executeApiTool('testTool', makeTool(), {}, auth);

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('The user belongs to several organizations.');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it.each(['Authorization', 'Proxy-Authorization', 'Cookie', 'Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'X-Forwarded-For', 'Forwarded'])(
    'should never let a tool argument set the %s header',
    async (header) => {
      mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: {} });
      const tool = makeTool({
        inputSchema: { type: 'object', properties: { [header]: { type: 'string' } } },
        executionParameters: [{ name: header, in: 'header' }],
      });

      await executeApiTool('testTool', tool, { [header]: 'injected' }, upstreamAuth('upstream-token'));

      const headers = (mockAxios.mock.calls[0][0] as any).headers as Record<string, string>;
      expect(Object.values(headers)).not.toContain('injected');
      expect(headers.authorization).toBe('Bearer upstream-token');
    },
  );

  it('should still pass other header parameters', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: {} });
    const tool = makeTool({
      inputSchema: { type: 'object', properties: { 'X-Request-Id': { type: 'string' } } },
      executionParameters: [{ name: 'X-Request-Id', in: 'header' }],
    });

    await executeApiTool('testTool', tool, { 'X-Request-Id': 'abc' });

    expect((mockAxios.mock.calls[0][0] as any).headers['x-request-id']).toBe('abc');
  });

  it('should ask the API for the raw response bytes', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: jsonBytes({}) });

    await executeApiTool('testTool', makeTool(), {});

    expect((mockAxios.mock.calls[0][0] as any).responseType).toBe('arraybuffer');
  });

  it('should pretty-print a JSON body that arrives as bytes', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, data: jsonBytes({ name: 'Ångström' }) });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('"name": "Ångström"');
  });

  /**
   * Decoding a PDF as text replaces every invalid UTF-8 sequence, so the file could never
   * be recovered; binary bodies must reach the client byte for byte.
   */
  it('should return a binary body intact as an embedded resource', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0xa0, 0xa1]), Buffer.from('\n%%EOF')]);
    mockAxios.mockResolvedValue({
      status: 201,
      headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="INV-2026-001.pdf"' },
      data: toArrayBuffer(pdf),
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect(result.isError).toBeFalsy();
    const resource = (result.content as any[]).find(item => item.type === 'resource').resource;
    expect(resource.mimeType).toBe('application/pdf');
    expect(resource.uri).toContain('INV-2026-001.pdf');
    expect(Buffer.from(resource.blob, 'base64').equals(pdf)).toBe(true);
    expect((result.content[0] as any).text).toContain(`${pdf.length} bytes`);
  });

  it('should decode a text body that arrives as bytes', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/xml' }, data: toArrayBuffer(Buffer.from('<Invoice>€</Invoice>')) });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('<Invoice>€</Invoice>');
  });

  it('should still explain an API error whose body arrives as bytes', async () => {
    mockAxios.mockRejectedValue(Object.assign(new Error('Request failed with status code 422'), {
      isAxiosError: true,
      response: { status: 422, statusText: 'Unprocessable Entity', data: jsonBytes({ message: 'The template id is invalid.' }), headers: { 'content-type': 'application/json' } },
      config: {},
    }));

    const result = await executeApiTool('testTool', makeTool(), {});

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain('The template id is invalid.');
  });

  it('should replace path parameters', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    const tool = makeTool({
      pathTemplate: '/templates/{templateId}',
      inputSchema: { type: 'object', properties: { templateId: { type: 'number' } } },
      executionParameters: [{ name: 'templateId', in: 'path' }],
    });

    await executeApiTool('getTemplate', tool, { templateId: 42 });

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.url).toContain('/templates/42');
    expect(config.url).not.toContain('{templateId}');
  });

  it('should pass query parameters', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    const tool = makeTool({
      inputSchema: { type: 'object', properties: { page: { type: 'number' }, per_page: { type: 'number' } } },
      executionParameters: [
        { name: 'page', in: 'query' },
        { name: 'per_page', in: 'query' },
      ],
    });

    await executeApiTool('listTool', tool, { page: 2, per_page: 10 });

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.params).toEqual({ page: 2, per_page: 10 });
  });

  it('should set header parameters', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    const tool = makeTool({
      inputSchema: { type: 'object', properties: { 'X-Custom': { type: 'string' } } },
      executionParameters: [{ name: 'X-Custom', in: 'header' }],
    });

    await executeApiTool('headerTool', tool, { 'X-Custom': 'value' });

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.headers['x-custom']).toBe('value');
  });

  it('should include request body for POST', async () => {
    mockAxios.mockResolvedValue({
      status: 201,
      headers: { 'content-type': 'application/json' },
      data: { id: 1 },
    });

    const tool = makeTool({
      method: 'post',
      inputSchema: { type: 'object', properties: { requestBody: { type: 'object' } } },
      requestBodyContentType: 'application/json',
    });

    await executeApiTool('createTool', tool, { requestBody: { name: 'test' } });

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.method).toBe('POST');
    expect(config.data).toEqual({ name: 'test' });
    expect(config.headers['content-type']).toBe('application/json');
  });

  it('should handle string response', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      data: 'plain text response',
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect(result.content[0] as any).toMatchObject({
      type: 'text',
      text: expect.stringContaining('plain text response'),
    });
  });

  it('should handle empty response', async () => {
    mockAxios.mockResolvedValue({
      status: 204,
      headers: { 'content-type': 'application/json' },
      data: null,
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect(result.content[0] as any).toMatchObject({
      type: 'text',
      text: expect.stringContaining('204'),
    });
  });

  it('should handle axios error with response', async () => {
    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 404,
      statusText: 'Not Found',
      data: 'Resource not found',
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('404');
    expect(result.isError).toBe(true);
  });

  it('should handle axios network error', async () => {
    const error = new Error('Network error') as any;
    error.isAxiosError = true;
    error.request = {};
    error.code = 'ECONNREFUSED';
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Network Error');
    expect((result.content[0] as any).text).toContain('ECONNREFUSED');
    expect(result.isError).toBe(true);
  });

  it('should handle non-axios error', async () => {
    mockAxios.mockRejectedValue(new Error('Something broke'));

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Something broke');
    expect(result.isError).toBe(true);
  });

  it('should return error for unresolved path parameters', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: {},
      data: {},
    });

    const tool = makeTool({
      pathTemplate: '/templates/{templateId}',
      inputSchema: { type: 'object', properties: { templateId: { type: 'number' } } },
      executionParameters: [{ name: 'templateId', in: 'path' }],
    });

    // Don't provide templateId — path param stays unresolved
    const result = await executeApiTool('getTemplate', tool, {});

    expect((result.content[0] as any).text).toContain('Failed to resolve path parameters');
    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('should handle numeric response data', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      data: 12345,
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('12345');
  });

  // --- Additional coverage tests ---

  it('should return validation error for invalid arguments (ZodError path)', async () => {
    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
        },
      },
    });

    // Pass a string where number is expected — Zod should reject
    const result = await executeApiTool('testTool', tool, { count: 'not-a-number' });

    expect((result.content[0] as any).text).toContain('Invalid arguments');
    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('should handle non-Error thrown during unexpected errors', async () => {
    mockAxios.mockRejectedValue('a plain string error');

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Unexpected error');
    expect((result.content[0] as any).text).toContain('a plain string error');
    expect(result.isError).toBe(true);
  });

  it('should handle axios error with JSON response data', async () => {
    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 422,
      statusText: 'Unprocessable Entity',
      data: { error: 'validation_failed', message: 'Invalid template ID' },
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('422');
    expect((result.content[0] as any).text).toContain('validation_failed');
    expect(result.isError).toBe(true);
  });

  it('should handle axios error with no response body', async () => {
    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 500,
      statusText: 'Internal Server Error',
      data: null,
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('500');
    expect((result.content[0] as any).text).toContain('No response body');
    expect(result.isError).toBe(true);
  });

  it('should handle axios request setup error (no response, no request)', async () => {
    const error = new Error('Invalid URL') as any;
    error.isAxiosError = true;
    // No .response and no .request — this is a setup error
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Request Setup Error');
    expect((result.content[0] as any).text).toContain('Invalid URL');
    expect(result.isError).toBe(true);
  });

  it('should handle axios error with long response data (truncation)', async () => {
    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 400,
      statusText: 'Bad Request',
      data: 'x'.repeat(500), // Longer than 200 char limit
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('400');
    expect((result.content[0] as any).text).toContain('...');
    expect(result.isError).toBe(true);
  });

  it('should handle axios network error without error code', async () => {
    const error = new Error('Network error') as any;
    error.isAxiosError = true;
    error.request = {};
    // No error.code
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Network Error');
    expect(result.isError).toBe(true);
  });

  it('should handle null/invalid inputSchema gracefully', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    });

    const tool = makeTool({ inputSchema: null as any });
    const result = await executeApiTool('testTool', tool, {});

    // Should fall back to passthrough schema and succeed
    expect(result.content[0] as any).toMatchObject({
      type: 'text',
      text: expect.stringContaining('200'),
    });
  });

  it('should skip null/undefined parameter values', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    const tool = makeTool({
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          filter: { type: 'string' },
        },
      },
      executionParameters: [
        { name: 'page', in: 'query' },
        { name: 'filter', in: 'query' },
      ],
    });

    await executeApiTool('testTool', tool, { page: 1 });

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.params).toEqual({ page: 1 });
    expect(config.params.filter).toBeUndefined();
  });

  it('should handle JSON stringify error for response data', async () => {
    // Create circular reference that JSON.stringify can't handle
    const circular: any = { a: 1 };
    circular.self = circular;

    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: circular,
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Stringify Error');
  });

  it('should handle axios error with un-serializable JSON response data', async () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 500,
      statusText: 'Internal Server Error',
      data: circular,
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('500');
    expect((result.content[0] as any).text).toContain('Could not serialize data');
    expect(result.isError).toBe(true);
  });

  it('should handle axios error without statusText', async () => {
    const error = new Error('Request failed') as any;
    error.isAxiosError = true;
    error.response = {
      status: 503,
      statusText: '',
      data: 'Service Unavailable',
    };
    mockAxios.mockRejectedValue(error);

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('503');
    expect((result.content[0] as any).text).toContain('Status text not available');
    expect(result.isError).toBe(true);
  });

  it('should not include request body when requestBody arg is undefined', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    const tool = makeTool({
      method: 'post',
      requestBodyContentType: 'application/json',
    });

    await executeApiTool('testTool', tool, {});

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.data).toBeUndefined();
  });
});

/**
 * Clients see each nullable field with a single type, but arguments are validated against
 * the tool definition itself, so null is still accepted where the API allows it.
 */
describe('executeApiTool with nullable fields', () => {
  it('accepts null for the nullable fields of create_template', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { response: {} } });
    const requestBody = {
      name: 'Labels',
      layout: { repeatLayout: null },
      pages: [{ layout: null, backgroundImage: null }],
    };

    const result = await executeApiTool('create_template', toolDefinitionMap.get('create_template')!, { requestBody });

    expect(result.isError).toBeFalsy();
    expect(mockAxios).toHaveBeenCalledTimes(1);
    expect((mockAxios.mock.calls[0][0] as any).data).toMatchObject(requestBody);
  });
});
