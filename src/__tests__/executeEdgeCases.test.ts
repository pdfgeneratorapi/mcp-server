import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { McpToolDefinition } from '../types.js';

/**
 * Edge case tests for executeApiTool that require mocking json-schema-to-zod.
 * Separated from execute.test.ts because these need a different mock setup.
 */

// Mock json-schema-to-zod to return invalid code
const mockJsonSchemaToZod = jest.fn<() => string>();
jest.unstable_mockModule('json-schema-to-zod', () => ({
  jsonSchemaToZod: mockJsonSchemaToZod,
}));

// Mock axios
const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, {
    isAxiosError: (e: any) => !!e.isAxiosError,
  }),
  __esModule: true,
}));

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
  mockJsonSchemaToZod.mockReset();
});

describe('executeApiTool - schema edge cases', () => {
  it('should fall back to passthrough when jsonSchemaToZod returns invalid code', async () => {
    // Return code that doesn't produce a valid Zod schema
    mockJsonSchemaToZod.mockReturnValue('42');

    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    // Should fall back to passthrough and succeed
    expect((result.content[0] as any).text).toContain('200');
    expect(result.isError).toBeUndefined();
  });

  it('should fall back to passthrough when jsonSchemaToZod throws', async () => {
    mockJsonSchemaToZod.mockImplementation(() => {
      throw new Error('Cannot convert schema');
    });

    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { ok: true },
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    // Should fall back to passthrough and succeed
    expect((result.content[0] as any).text).toContain('200');
    expect(result.isError).toBeUndefined();
  });

  it('should fall back to passthrough when generated code throws syntax error', async () => {
    // Return syntactically invalid JS
    mockJsonSchemaToZod.mockReturnValue('{{invalid js}}');

    mockAxios.mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      data: { result: 'still works' },
    });

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('200');
  });

  it('should handle validation setup error (non-ZodError from parse)', async () => {
    // Return code that produces an object with a parse() that throws a regular Error
    mockJsonSchemaToZod.mockReturnValue(
      '({ parse: function() { throw new Error("custom parse error"); } })'
    );

    const result = await executeApiTool('testTool', makeTool(), {});

    expect((result.content[0] as any).text).toContain('Internal error during validation setup');
    expect((result.content[0] as any).text).toContain('custom parse error');
    expect(result.isError).toBe(true);
  });
});
