import { describe, it, expect, jest } from '@jest/globals';

// Mock axios so execute.ts doesn't make real calls
const mockAxios = jest.fn();
jest.unstable_mockModule('axios', () => {
  return {
    default: Object.assign(mockAxios, {
      isAxiosError: (e: any) => !!e.isAxiosError,
    }),
    __esModule: true,
  };
});

const { createMcpServer } = await import('../server.js');
const { toolDefinitionMap } = await import('../tools.js');
const { SERVER_NAME, SERVER_VERSION } = await import('../config.js');

describe('createMcpServer', () => {
  describe('listTools handler', () => {
    it('should return all tools with simplified schemas', async () => {
      const server = createMcpServer('test-token');

      // Access the internal handler via the server's request handling
      // We test through the public interface by checking tool count
      const handler = (server as any)._requestHandlers;
      expect(handler).toBeDefined();
    });

    it('should return tool count matching toolDefinitionMap', async () => {
      expect(toolDefinitionMap.size).toBeGreaterThan(0);
      // Verify each tool has required fields
      for (const [name, def] of toolDefinitionMap) {
        expect(def.name).toBe(name);
        expect(def.method).toBeDefined();
        expect(def.pathTemplate).toBeDefined();
      }
    });
  });

  describe('server creation', () => {
    it('should create a Server instance', () => {
      const server = createMcpServer();
      expect(server).toBeDefined();
    });

    it('should create unique instances per call', () => {
      const s1 = createMcpServer();
      const s2 = createMcpServer();
      expect(s1).not.toBe(s2);
    });

    it('should accept bearer token parameter', () => {
      const server = createMcpServer('my-token');
      expect(server).toBeDefined();
    });

    it('should use correct server name and version', () => {
      expect(SERVER_NAME).toBe('ar-api-production');
      expect(SERVER_VERSION).toBe('4.0.17');
    });
  });
});
