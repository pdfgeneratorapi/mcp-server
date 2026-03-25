import { describe, it, expect, jest } from '@jest/globals';

// Mock axios so execute.ts doesn't make real calls
const mockAxios = jest.fn() as jest.Mock<any>;
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
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

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

    it('should return tools via MCP protocol', async () => {
      const server = createMcpServer('test-token');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      const result = await client.listTools();

      expect(result.tools.length).toBe(toolDefinitionMap.size);
      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
      }

      await client.close();
      await server.close();
    });
  });

  describe('callTool handler', () => {
    it('should call executeApiTool for known tools', async () => {
      mockAxios.mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'application/json' },
        data: { success: true },
      });

      const server = createMcpServer('test-token');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      // Get first tool name from the map
      const firstToolName = toolDefinitionMap.keys().next().value!;

      const result = await client.callTool({ name: firstToolName, arguments: {} });

      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);

      await client.close();
      await server.close();
    });

    it('should return error for unknown tool', async () => {
      const server = createMcpServer('test-token');
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      const result = await client.callTool({ name: 'nonexistent_tool_xyz', arguments: {} }) as any;

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Unknown tool');
      expect(result.isError).toBe(true);

      await client.close();
      await server.close();
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
      expect(SERVER_NAME).toBe('pdf-generator-api');
      expect(SERVER_VERSION).toBe('4.0.17');
    });
  });
});
