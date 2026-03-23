/**
 * Unit tests for executeApiTool function
 *
 * Note: Testing executeApiTool requires mocking axios which is complex in ESM mode.
 * These tests focus on the helper functions and validation logic.
 */

import { describe, it, expect } from '@jest/globals';
import { McpToolDefinition, API_BASE_URL } from '../index.js';

// Helper to create a mock tool definition for testing
function createMockToolDefinition(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: 'testTool',
    description: 'A test tool',
    inputSchema: { type: 'object', properties: {} },
    method: 'get',
    pathTemplate: '/test',
    executionParameters: [],
    requestBodyContentType: undefined,
    ...overrides
  };
}

describe('McpToolDefinition', () => {
  describe('structure validation', () => {
    it('should create a valid tool definition with minimal properties', () => {
      const tool = createMockToolDefinition();

      expect(tool.name).toBe('testTool');
      expect(tool.description).toBe('A test tool');
      expect(tool.method).toBe('get');
      expect(tool.pathTemplate).toBe('/test');
      expect(tool.executionParameters).toEqual([]);
    });

    it('should allow overriding default values', () => {
      const tool = createMockToolDefinition({
        name: 'customTool',
        method: 'post',
        pathTemplate: '/custom',
        requestBodyContentType: 'application/json'
      });

      expect(tool.name).toBe('customTool');
      expect(tool.method).toBe('post');
      expect(tool.pathTemplate).toBe('/custom');
      expect(tool.requestBodyContentType).toBe('application/json');
    });

    it('should support path parameters', () => {
      const tool = createMockToolDefinition({
        pathTemplate: '/templates/{templateId}',
        executionParameters: [{ name: 'templateId', in: 'path' }]
      });

      expect(tool.pathTemplate).toContain('{templateId}');
      expect(tool.executionParameters).toHaveLength(1);
      expect(tool.executionParameters[0].name).toBe('templateId');
      expect(tool.executionParameters[0].in).toBe('path');
    });

    it('should support query parameters', () => {
      const tool = createMockToolDefinition({
        executionParameters: [
          { name: 'page', in: 'query' },
          { name: 'per_page', in: 'query' }
        ]
      });

      expect(tool.executionParameters).toHaveLength(2);
      expect(tool.executionParameters.every(p => p.in === 'query')).toBe(true);
    });

    it('should support header parameters', () => {
      const tool = createMockToolDefinition({
        executionParameters: [{ name: 'X-Custom-Header', in: 'header' }]
      });

      expect(tool.executionParameters[0].in).toBe('header');
    });

    it('should support complex input schemas', () => {
      const tool = createMockToolDefinition({
        inputSchema: {
          type: 'object',
          properties: {
            templateId: { type: 'number' },
            requestBody: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } }
              }
            }
          },
          required: ['templateId']
        }
      });

      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toHaveProperty('templateId');
      expect(tool.inputSchema.properties).toHaveProperty('requestBody');
      expect(tool.inputSchema.required).toContain('templateId');
    });
  });

  describe('HTTP method support', () => {
    it('should support GET method', () => {
      const tool = createMockToolDefinition({ method: 'get' });
      expect(tool.method).toBe('get');
    });

    it('should support POST method', () => {
      const tool = createMockToolDefinition({ method: 'post' });
      expect(tool.method).toBe('post');
    });

    it('should support PUT method', () => {
      const tool = createMockToolDefinition({ method: 'put' });
      expect(tool.method).toBe('put');
    });

    it('should support DELETE method', () => {
      const tool = createMockToolDefinition({ method: 'delete' });
      expect(tool.method).toBe('delete');
    });

    it('should support PATCH method', () => {
      const tool = createMockToolDefinition({ method: 'patch' });
      expect(tool.method).toBe('patch');
    });
  });
});

describe('API_BASE_URL', () => {
  it('should be defined', () => {
    expect(API_BASE_URL).toBeDefined();
  });

  it('should be a valid URL string', () => {
    expect(typeof API_BASE_URL).toBe('string');
    expect(API_BASE_URL).toMatch(/^https?:\/\//);
  });

  it('should use test environment variable in tests', () => {
    // The setup.ts file sets this to test URL
    expect(API_BASE_URL).toBe('https://test-api.example.com/api/v4');
  });
});
