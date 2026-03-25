import { describe, it, expect, jest, afterAll, afterEach, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
// Mock axios so server.ts -> execute.ts doesn't make real calls
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(jest.fn(), {
    isAxiosError: (e: any) => !!e.isAxiosError,
  }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { SERVER_NAME, SERVER_VERSION } = await import('../config.js');

// Servers to close after all tests
const servers: any[] = [];
afterAll(() => {
  for (const s of servers) {
    try { s.close(); } catch {}
  }
});

describe('setupStreamableHttpServer', () => {
  let app: any;
  let baseUrl: string;

  it('should create an app instance and return port info', async () => {
    app = await setupStreamableHttpServer(0);
    servers.push(app.server);
    baseUrl = `http://localhost:${app.port}`;
    expect(app).toBeDefined();
    expect(typeof app.port).toBe('number');
    expect(app.port).toBeGreaterThan(0);
  });

  describe('health endpoint', () => {
    it('should return 200 with server info', async () => {
      const res = await fetch(`${baseUrl}/health`);

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
      const res = await fetch(`${baseUrl}/mcp`);
      expect(res.status).toBe(405);
    });

    it('should return 400 for POST /mcp without session or initialize', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.message).toContain('Bad Request');
    });

    it('should return 400 for POST /mcp with invalid session ID', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'mcp-session-id': 'nonexistent-session-id',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('static file serving', () => {
    it('should return 404 for missing static files', async () => {
      const res = await fetch(`${baseUrl}/nonexistent.html`);
      expect(res.status).toBe(404);
    });

    it('should serve index.html from public directory', async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type');
      expect(ct).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('PDF Generator API');
    });

    it('should block directory traversal attempts', async () => {
      const res = await fetch(`${baseUrl}/../../../etc/passwd`);
      expect([403, 404]).toContain(res.status);
    });

    it('should serve CSS files with correct content type', async () => {
      // Create a temp CSS file
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const cssPath = path.join(publicDir, 'test.css');
      fs.writeFileSync(cssPath, 'body { color: red; }');
      try {
        const res = await fetch(`${baseUrl}/test.css`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/css');
      } finally {
        fs.unlinkSync(cssPath);
      }
    });

    it('should serve JS files with correct content type', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const jsPath = path.join(publicDir, 'test.js');
      fs.writeFileSync(jsPath, 'console.log("test");');
      try {
        const res = await fetch(`${baseUrl}/test.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/javascript');
      } finally {
        fs.unlinkSync(jsPath);
      }
    });

    it('should serve JSON files with correct content type', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const jsonPath = path.join(publicDir, 'test.json');
      fs.writeFileSync(jsonPath, '{"test": true}');
      try {
        const res = await fetch(`${baseUrl}/test.json`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
      } finally {
        fs.unlinkSync(jsonPath);
      }
    });

    it('should serve SVG files with correct content type', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const svgPath = path.join(publicDir, 'test.svg');
      fs.writeFileSync(svgPath, '<svg></svg>');
      try {
        const res = await fetch(`${baseUrl}/test.svg`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/svg+xml');
      } finally {
        fs.unlinkSync(svgPath);
      }
    });

    it('should serve PNG files with correct content type', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const pngPath = path.join(publicDir, 'test.png');
      // Minimal 1x1 transparent PNG
      fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElFTkSuQmCC', 'base64'));
      try {
        const res = await fetch(`${baseUrl}/test.png`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/png');
      } finally {
        fs.unlinkSync(pngPath);
      }
    });

    it('should serve JPG files with correct content type', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const jpgPath = path.join(publicDir, 'test.jpg');
      fs.writeFileSync(jpgPath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])); // JPEG magic bytes
      try {
        const res = await fetch(`${baseUrl}/test.jpg`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('image/jpeg');
      } finally {
        fs.unlinkSync(jpgPath);
      }
    });

    it('should serve unknown extensions as text/plain', async () => {
      const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
      const txtPath = path.join(publicDir, 'test.txt');
      fs.writeFileSync(txtPath, 'plain text');
      try {
        const res = await fetch(`${baseUrl}/test.txt`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/plain');
      } finally {
        fs.unlinkSync(txtPath);
      }
    });
  });
});

describe('MCP session lifecycle (real HTTP)', () => {
  let app: any;
  let baseUrl: string;

  it('should initialize, reuse session, and handle tools/list', async () => {
    app = await setupStreamableHttpServer(0);
    servers.push(app.server);
    baseUrl = `http://localhost:${app.port}`;

    // Step 1: Initialize
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer test-lifecycle-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-lifecycle', version: '1.0.0' },
        },
      }),
    });

    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // Consume the body
    await initRes.text();

    // Step 2: Reuse session — send tools/list
    const listRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 2,
      }),
    });

    expect(listRes.status).toBe(200);
    await listRes.text();
  });

  it('should initialize without bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 10,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'no-auth-client', version: '1.0.0' },
        },
      }),
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  it('should initialize with batch (array) request', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify([{
        jsonrpc: '2.0',
        method: 'initialize',
        id: 20,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'batch-client', version: '1.0.0' },
        },
      }]),
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  it('should handle malformed JSON body gracefully', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);
    await res.text();
  });
});

describe('setupStreamableHttpServer with custom CORS', () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  afterEach(() => {
    if (originalCorsOrigin) {
      process.env.CORS_ORIGIN = originalCorsOrigin;
    } else {
      delete process.env.CORS_ORIGIN;
    }
  });

  it('should restrict CORS when CORS_ORIGIN is set', async () => {
    process.env.CORS_ORIGIN = 'https://example.com,https://app.example.com';
    const corsApp = await setupStreamableHttpServer(0);
    servers.push(corsApp.server);

    const res = await fetch(`http://localhost:${corsApp.port}/health`, {
      headers: { 'Origin': 'https://example.com' },
    });

    expect(res.status).toBe(200);
    const allowOrigin = res.headers.get('access-control-allow-origin');
    expect(allowOrigin).toBe('https://example.com');
  });
});
