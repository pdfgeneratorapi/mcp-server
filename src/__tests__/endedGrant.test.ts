import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/server';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');
const { UpstreamCredentialError } = await import('../credentials/upstream.js');

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });
const MODERN = '2026-07-28';
const TOKEN = 'user-a.client-1';

const verifier = {
  verify: async (token: string): Promise<AuthInfo> => {
    const [sub, clientId] = token.split('.');
    return { token, clientId, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 1800, extra: { sub, workspaceId: 1, jti: token } };
  },
};

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  mockAxios.mockReset();
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** Credentials whose endpoint refuses the grant the way the api does. */
function refusing(status: number, code: string) {
  return {
    get: async () => {
      throw new UpstreamCredentialError(`No API credential for this connection: ${code}`, status, code);
    },
    invalidate: () => {},
  };
}

async function start(credentials: { get: () => Promise<string>; invalidate: () => void }) {
  const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
  servers.push(app.server);

  return `http://localhost:${app.port}/mcp`;
}

function headers(extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Authorization': `Bearer ${TOKEN}`, ...extra };
}

async function openSession(url: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  });
  await response.text();

  return response.headers.get('mcp-session-id') as string;
}

async function legacyCall(url: string, sessionId: string, id = 2) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers({ 'mcp-session-id': sessionId }),
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_status', arguments: {} } }),
  });

  return { response, body: await response.text() };
}

describe('a connection that has ended', () => {
  it.each([
    ['revoked', 'revoked_grant'],
    ['unknown', 'unknown_grant'],
    ['expired', 'expired_grant'],
  ])('answers a tool call on a %s grant with the challenge to sign in again', async (_label, code) => {
    const url = await start(refusing(403, code));
    const sessionId = await openSession(url);

    const { response } = await legacyCall(url, sessionId);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('answers a 2026-07-28 tool call on a revoked grant the same way', async () => {
    const url = await start(refusing(403, 'revoked_grant'));

    const response = await fetch(url, {
      method: 'POST',
      headers: headers({ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_status' }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_status',
          arguments: {},
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN,
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  /**
   * A credential cached before the revoke passes the check, and the API refuses it only once the
   * call is under way. That call can only report the end; the next one is challenged.
   */
  it('tells the client to send again when the connection ended during the call, then challenges it', async () => {
    let ended = false;
    mockAxios.mockRejectedValue({ isAxiosError: true, response: { status: 401, headers: {}, data: Buffer.from('{}') } });
    const url = await start({
      get: async () => {
        if (ended) {
          throw new UpstreamCredentialError('No API credential for this connection: The access token has been revoked.', 403, 'revoked_grant');
        }

        return 'cached-credential';
      },
      invalidate: () => {
        ended = true;
      },
    });
    const sessionId = await openSession(url);

    const first = await legacyCall(url, sessionId);

    expect(first.response.status).toBe(200);
    expect(first.body).toContain('"isError":true');
    expect(first.body).toContain('This connection has ended');
    expect(first.body).toContain('Send the request again');

    const second = await legacyCall(url, sessionId, 3);

    expect(second.response.status).toBe(401);
    expect(second.response.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  /** Signing in again would not help with these, so the tool reports them. */
  it('still reports other credential refusals as a tool error', async () => {
    const url = await start(refusing(409, 'no_api_key'));
    const sessionId = await openSession(url);

    const { response, body } = await legacyCall(url, sessionId);

    expect(response.status).toBe(200);
    expect(body).toContain('no_api_key');
    expect(body).toContain('"isError":true');
  });

  it('lets a call through when the credential can be issued', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":{}}') });
    const url = await start({ get: async () => 'upstream-token', invalidate: () => {} });
    const sessionId = await openSession(url);

    const { response } = await legacyCall(url, sessionId);

    expect(response.status).toBe(200);
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });
});
