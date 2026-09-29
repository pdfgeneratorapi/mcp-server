import { describe, it, expect, afterEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');
const { RateLimiter, loadRateLimits, identityKey } = await import('../transport/rateLimit.js');

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });

/** A token reads "<subject>.<client>.<issued>", so a test can act as another user or client. */
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

describe('RateLimiter', () => {
  it('lets an identity spend its minute at once, then refuses with how long to wait', () => {
    const limiter = new RateLimiter(3, () => 0);

    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 20 });
  });

  it('earns the allowance back over the minute', () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now);
    for (let i = 0; i < 60; i++) {
      limiter.take('a');
    }

    expect(limiter.take('a').allowed).toBe(false);
    now += 1000;
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('never saves up more than one minute of allowance', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.take('a');
    now += 10 * 60_000;

    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, false]);
  });

  it('counts every identity on its own', () => {
    const limiter = new RateLimiter(1, () => 0);

    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });

  it('allows everything when the limit is 0', () => {
    const limiter = new RateLimiter(0, () => 0);

    expect(Array.from({ length: 1000 }, () => limiter.take('a').allowed).every(Boolean)).toBe(true);
    expect(limiter.size()).toBe(0);
  });

  it('keeps track of a bounded number of identities', () => {
    let now = 0;
    const limiter = new RateLimiter(10, () => now, 100);

    for (let i = 0; i < 1000; i++) {
      now += 1;
      limiter.take(`identity-${i}`);
    }

    expect(limiter.size()).toBeLessThanOrEqual(100);
  });
});

describe('loadRateLimits', () => {
  it('defaults to 600 requests and 30 new sessions a minute', () => {
    expect(loadRateLimits({})).toEqual({ requestsPerMinute: 600, initializePerMinute: 30 });
  });

  it('reads the configured limits, 0 included', () => {
    expect(loadRateLimits({ MCP_REQUESTS_PER_MINUTE: '120', MCP_INITIALIZE_PER_MINUTE: '0' }))
      .toEqual({ requestsPerMinute: 120, initializePerMinute: 0 });
  });

  it.each(['abc', '-1', '1.5', '10 requests'])('refuses to start with a limit of "%s"', (value) => {
    expect(() => loadRateLimits({ MCP_REQUESTS_PER_MINUTE: value })).toThrow(/MCP_REQUESTS_PER_MINUTE/);
  });
});

describe('identityKey', () => {
  it('follows the subject and the client, never the token', () => {
    const first = identityKey('https://auth.example.test', { token: 'a', clientId: '17', scopes: [], extra: { sub: '4821' } });
    const refreshed = identityKey('https://auth.example.test', { token: 'b', clientId: '17', scopes: [], extra: { sub: '4821' } });

    expect(first).toBe(refreshed);
    expect(identityKey('https://auth.example.test', { token: 'a', clientId: '18', scopes: [], extra: { sub: '4821' } })).not.toBe(first);
  });
});

describe('rate limits on the MCP endpoint', () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  async function startServer(env: Record<string, string>) {
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

  function headers(token: string, sessionId?: string) {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    };
  }

  function initialize(url: string, token: string) {
    return fetch(url, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
      }),
    });
  }

  function listTools(url: string, token: string, sessionId: string) {
    return fetch(url, {
      method: 'POST',
      headers: headers(token, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
  }

  it('answers 429 with Retry-After as a JSON-RPC error once an identity is over its limit', async () => {
    const url = await startServer({ MCP_REQUESTS_PER_MINUTE: '2' });
    const opened = await initialize(url, 'user-a.client-1.first');
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();
    await (await listTools(url, 'user-a.client-1.first', sessionId)).text();

    const refused = await listTools(url, 'user-a.client-1.refreshed', sessionId);
    const body = await refused.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.message).toMatch(/Too Many Requests/);
    expect(body.id).toBeNull();
  });

  it('leaves another identity unaffected', async () => {
    const url = await startServer({ MCP_REQUESTS_PER_MINUTE: '1' });
    await (await initialize(url, 'user-a.client-1.first')).text();

    const other = await initialize(url, 'user-b.client-1.first');
    await other.text();

    expect(other.status).toBe(200);
    expect((await initialize(url, 'user-a.client-2.first')).status).toBe(200);
  });

  it('lets browsers read Retry-After', async () => {
    const url = await startServer({ MCP_REQUESTS_PER_MINUTE: '1' });
    await (await initialize(url, 'user-a.client-1.first')).text();

    const refused = await fetch(url, {
      method: 'POST',
      headers: { ...headers('user-a.client-1.first'), Origin: 'https://client.example.test' },
      body: '{}',
    });
    await refused.text();

    expect(refused.status).toBe(429);
    expect(refused.headers.get('access-control-expose-headers') ?? '').toMatch(/Retry-After/i);
  });

  /**
   * Every session holds server memory, so opening them has its own, smaller allowance.
   */
  it('limits new sessions separately from requests', async () => {
    const url = await startServer({ MCP_REQUESTS_PER_MINUTE: '100', MCP_INITIALIZE_PER_MINUTE: '1' });
    const opened = await initialize(url, 'user-a.client-1.first');
    const sessionId = opened.headers.get('mcp-session-id') as string;
    await opened.text();

    const second = await initialize(url, 'user-a.client-1.first');
    await second.text();
    const list = await listTools(url, 'user-a.client-1.first', sessionId);
    await list.text();

    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    expect(list.status).toBe(200);
  });

  it('never limits a request when the limits are 0', async () => {
    const url = await startServer({ MCP_REQUESTS_PER_MINUTE: '0', MCP_INITIALIZE_PER_MINUTE: '0' });

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const response = await initialize(url, 'user-a.client-1.first');
      await response.text();
      statuses.push(response.status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});
