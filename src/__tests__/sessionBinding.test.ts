import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer, createHttpApp } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');

const RESOURCE = 'https://mcp.example.test/mcp';
const config = loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: 'https://auth.example.test' });

/** A token reads "<subject>.<client>.<issued>", so a test can act as another user, client or refreshed token. */
const verifier = {
  verify: async (token: string): Promise<AuthInfo> => {
    const [sub, clientId] = token.split('.');
    return {
      token,
      clientId,
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
      extra: { sub, workspaceId: 1, jti: token },
    };
  },
};

const credentials = { get: async () => 'upstream-token', invalidate: () => {} };

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function startServer(env: Record<string, string> = {}) {
  const previous = { ...process.env };
  Object.assign(process.env, env);

  try {
    const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
    servers.push(app.server);
    return `http://localhost:${app.port}/mcp`;
  } finally {
    process.env = previous;
  }
}

function headers(token: string, sessionId?: string, extra: Record<string, string> = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...extra,
  };
}

function initializeBody(id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
}

async function openSession(url: string, token: string): Promise<string> {
  const response = await fetch(url, { method: 'POST', headers: headers(token), body: initializeBody() });
  const sessionId = response.headers.get('mcp-session-id');
  await response.text();

  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function listTools(url: string, token: string, sessionId: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  await response.text();

  return response;
}

describe('session identity binding', () => {
  it('lets the owner keep using the session', async () => {
    const url = await startServer();
    const sessionId = await openSession(url, 'user-a.client-1.first');

    expect((await listTools(url, 'user-a.client-1.first', sessionId)).status).toBe(200);
  });

  /**
   * Sessions are bound to who owns them, not to the token's bytes, so a refreshed token
   * continues instead of being locked out.
   */
  it('accepts a refreshed token of the same user and client', async () => {
    const url = await startServer();
    const sessionId = await openSession(url, 'user-a.client-1.first');

    expect((await listTools(url, 'user-a.client-1.refreshed', sessionId)).status).toBe(200);
  });

  it.each([
    ['another user', 'user-b.client-1.first'],
    ['another client of the same user', 'user-a.client-2.first'],
  ])('answers 404 for a session belonging to %s', async (_label, token) => {
    const url = await startServer();
    const sessionId = await openSession(url, 'user-a.client-1.first');

    expect((await listTools(url, token, sessionId)).status).toBe(404);
  });

  it('answers 404 for a session it does not know, so ids cannot be probed', async () => {
    const url = await startServer();

    expect((await listTools(url, 'user-a.client-1.first', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('terminates a session on DELETE and forgets it', async () => {
    const url = await startServer();
    const token = 'user-a.client-1.first';
    const sessionId = await openSession(url, token);

    const deleted = await fetch(url, { method: 'DELETE', headers: headers(token, sessionId) });
    await deleted.text();

    expect(deleted.status).toBeLessThan(300);
    expect((await listTools(url, token, sessionId)).status).toBe(404);
  });

  it('refuses to terminate a session of another user', async () => {
    const url = await startServer();
    const token = 'user-a.client-1.first';
    const sessionId = await openSession(url, token);

    const deleted = await fetch(url, { method: 'DELETE', headers: headers('user-b.client-1.first', sessionId) });
    await deleted.text();

    expect(deleted.status).toBe(404);
    expect((await listTools(url, token, sessionId)).status).toBe(200);
  });
});

describe('transport limits', () => {
  it('refuses a new session once the cap is reached, keeping the ones it has', async () => {
    const url = await startServer({ MCP_MAX_SESSIONS: '1' });
    const sessionId = await openSession(url, 'user-a.client-1.first');

    const refused = await fetch(url, { method: 'POST', headers: headers('user-b.client-1.first'), body: initializeBody(3) });
    const body = await refused.json();

    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    expect((body as any).error?.message ?? '').toMatch(/capacity|session/i);
    expect((await listTools(url, 'user-a.client-1.first', sessionId)).status).toBe(200);
  });

  it('refuses a body larger than the limit', async () => {
    const url = await startServer({ MCP_MAX_BODY_BYTES: '200' });

    const response = await fetch(url, {
      method: 'POST',
      headers: headers('user-a.client-1.first'),
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_status', arguments: { padding: 'x'.repeat(500) } } }),
    });
    await response.text();

    expect(response.status).toBe(413);
  });
});

describe('host and origin guards', () => {
  it.each([
    ['answers for the configured resource host', 'https://mcp.example.test/mcp', false],
    ['refuses a host it does not answer for, which is how DNS rebinding arrives', 'https://evil.example.test/mcp', true],
  ])('%s', async (_label, requestUrl, refused) => {
    const app = createHttpApp(config, verifier, credentials);

    const response = await app.request(requestUrl, {
      method: 'POST',
      headers: headers('user-a.client-1.first'),
      body: initializeBody(),
    });
    const body = await response.text();

    expect(response.status === 403).toBe(refused);
    expect(body.includes('Unknown host')).toBe(refused);
  });

  it('accepts a desktop client, which sends no Origin at all', async () => {
    const url = await startServer({ CORS_ORIGIN: 'https://app.example.test' });

    expect((await fetch(url, { method: 'POST', headers: headers('user-a.client-1.first'), body: initializeBody() })).status).toBe(200);
  });

  it('refuses an Origin outside the configured list', async () => {
    const url = await startServer({ CORS_ORIGIN: 'https://app.example.test' });

    const response = await fetch(url, {
      method: 'POST',
      headers: headers('user-a.client-1.first', undefined, { Origin: 'https://evil.example.test' }),
      body: initializeBody(),
    });
    await response.text();

    expect(response.status).toBe(403);
  });

  it('accepts any Origin while none are configured, as desktop clients need', async () => {
    const url = await startServer();

    const response = await fetch(url, {
      method: 'POST',
      headers: headers('user-a.client-1.first', undefined, { Origin: 'https://anything.example.test' }),
      body: initializeBody(),
    });
    await response.text();

    expect(response.status).toBe(200);
  });
});
