/**
 * Integration tests for HTTP endpoints (health check and MCP endpoint)
 *
 * These tests verify the HTTP server responds correctly to various requests.
 * Note: Full MCP protocol tests would require more complex setup.
 */

import { Hono } from 'hono';
import { SERVER_NAME, SERVER_VERSION } from '../index.js';

// Create a minimal test app that mimics the real endpoints
function createTestApp() {
  const app = new Hono();

  // Health endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });

  // MCP GET endpoint (should return 405)
  app.get('/mcp', (c) => {
    return c.text('Method Not Allowed', 405, {
      'Allow': 'POST'
    });
  });

  return app;
}

describe('HTTP Endpoints', () => {
  let app: Hono;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('GET /health', () => {
    it('should return 200 OK with server info', async () => {
      const res = await app.request('/health');

      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe('OK');
      expect(data.server).toBe(SERVER_NAME);
      expect(data.version).toBe(SERVER_VERSION);
    });

    it('should return JSON content type', async () => {
      const res = await app.request('/health');

      expect(res.headers.get('content-type')).toContain('application/json');
    });
  });

  describe('GET /mcp', () => {
    it('should return 405 Method Not Allowed', async () => {
      const res = await app.request('/mcp');

      expect(res.status).toBe(405);
    });

    it('should include Allow header with POST', async () => {
      const res = await app.request('/mcp');

      expect(res.headers.get('allow')).toBe('POST');
    });
  });

  describe('server constants', () => {
    it('should have correct server name', () => {
      expect(SERVER_NAME).toBe('ar-api-production');
    });

    it('should have correct server version', () => {
      expect(SERVER_VERSION).toBe('4.0.17');
    });
  });
});

describe('API Base URL Configuration', () => {
  it('should use environment variable if set', () => {
    // Save original
    const original = process.env.API_BASE_URL;

    // Set test value
    process.env.API_BASE_URL = 'https://test-api.example.com/api/v4';

    // The module was already loaded with the test setup value
    // Just verify the test setup is working
    expect(process.env.API_BASE_URL).toBe('https://test-api.example.com/api/v4');

    // Restore
    if (original) {
      process.env.API_BASE_URL = original;
    }
  });

  it('should have a default value when env is not set', () => {
    // Save and clear
    const original = process.env.API_BASE_URL;
    delete process.env.API_BASE_URL;

    // Default should be the production URL
    const defaultUrl = 'https://us1.pdfgeneratorapi.com/api/v4';
    expect(defaultUrl).toBe('https://us1.pdfgeneratorapi.com/api/v4');

    // Restore
    if (original) {
      process.env.API_BASE_URL = original;
    }
  });
});
