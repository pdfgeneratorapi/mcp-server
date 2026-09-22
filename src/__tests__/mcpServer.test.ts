/**
 * Unit tests for createMcpServer function
 */

import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createStaticCredentials } from '../credentials/upstream.js';

describe('createMcpServer', () => {
  describe('server creation', () => {
    it('should create a Server instance', () => {
      const server = createMcpServer();
      expect(server).toBeInstanceOf(Server);
    });

    it('should create a new server instance each call', () => {
      const server1 = createMcpServer();
      const server2 = createMcpServer();
      expect(server1).not.toBe(server2);
    });

    it('should accept upstream credentials', () => {
      const server = createMcpServer(createStaticCredentials('test-token-123'));
      expect(server).toBeInstanceOf(Server);
    });

    it('should work without upstream credentials', () => {
      const server = createMcpServer();
      expect(server).toBeInstanceOf(Server);
    });
  });

  describe('server configuration', () => {
    it('should use correct server name constant', () => {
      expect(SERVER_NAME).toBe('pdf-generator-api');
    });

    it('should use correct server version constant', () => {
      expect(SERVER_VERSION).toBe('4.0.17');
    });
  });
});
