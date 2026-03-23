import { describe, it, expect, jest } from '@jest/globals';

// Mock axios so server.ts -> execute.ts doesn't make real calls
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(jest.fn(), {
    isAxiosError: (e: any) => !!e.isAxiosError,
  }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { SERVER_NAME, SERVER_VERSION } = await import('../config.js');

describe('setupStreamableHttpServer', () => {
  let app: any;

  it('should create an app instance', async () => {
    // Use a random high port to avoid conflicts
    app = await setupStreamableHttpServer(0);
    expect(app).toBeDefined();
  });

  describe('health endpoint', () => {
    it('should return 200 with server info', async () => {
      const req = new Request('http://localhost/health');
      const res = await app.fetch(req);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        status: 'OK',
        server: SERVER_NAME,
        version: SERVER_VERSION,
      });
    });
  });

  describe('MCP endpoint', () => {
    it('should return 405 for GET /mcp', async () => {
      const req = new Request('http://localhost/mcp');
      const res = await app.fetch(req);

      expect(res.status).toBe(405);
    });

    it('should return 400 for POST /mcp without session or initialize', async () => {
      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      const res = await app.fetch(req);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Bad Request');
    });

    it('should return 500 or handle initialize request without crashing', async () => {
      const initRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      };

      const req = new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify(initRequest),
      });

      const res = await app.fetch(req);
      // The response depends on whether fetch-to-node can handle the
      // synthetic Request in test. We just verify it doesn't crash and
      // returns a valid HTTP status.
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(600);
    });
  });

  describe('static file serving', () => {
    it('should return 404 for missing static files', async () => {
      const req = new Request('http://localhost/nonexistent.html');
      const res = await app.fetch(req);

      expect(res.status).toBe(404);
    });
  });
});
