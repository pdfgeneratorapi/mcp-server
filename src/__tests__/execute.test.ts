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

  it('should set Authorization header when bearer token provided', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    await executeApiTool('testTool', makeTool(), {}, 'my-jwt-token');

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.headers.authorization).toBe('Bearer my-jwt-token');
  });

  it('should not set Authorization header when no token', async () => {
    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: {},
    });

    await executeApiTool('testTool', makeTool(), {});

    const config = mockAxios.mock.calls[0][0] as any;
    expect(config.headers.authorization).toBeUndefined();
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
  });

  it('should handle non-axios error', async () => {
    mockAxios.mockRejectedValue(new Error('Something broke'));

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Something broke');
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
});
