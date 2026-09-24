import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });

/** The token names the scopes it grants, with ~ for the colon a bearer token cannot hold. */
const verifier = {
  verify: async (token: string): Promise<AuthInfo> => {
    const [sub, clientId, scopes = ''] = token.split('.');
    return {
      token,
      clientId,
      scopes: scopes === '' ? [] : scopes.split('+').map(scope => scope.replace('~', ':')),
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
      extra: { sub, workspaceId: 1, jti: token },
    };
  },
};

const credentials = { get: async () => 'upstream-token', invalidate: () => {} };

const servers: Array<{ close: () => void }> = [];
const previousMode = process.env.MCP_SCOPE_ENFORCEMENT;
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  if (previousMode === undefined) {
    delete process.env.MCP_SCOPE_ENFORCEMENT;
  } else {
    process.env.MCP_SCOPE_ENFORCEMENT = previousMode;
  }
});

function headers(token: string, sessionId?: string) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function connect(token: string) {
  const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
  servers.push(app.server);
  const url = `http://localhost:${app.port}/mcp`;

  const init = await fetch(url, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id') as string;
  await init.text();

  return { url, sessionId };
}

function callTool(url: string, token: string, sessionId: string, name: string) {
  return fetch(url, {
    method: 'POST',
    headers: headers(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } }),
  });
}

describe('scope enforcement over HTTP', () => {
  it('answers a call outside the grant with the step-up challenge', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'delete_template');
    await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain('scope="templates:delete"');
  });

  it('lets a call the grant covers through', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":[]}') });
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'get_templates');
    await response.text();

    expect(response.status).toBe(200);
  });

  /**
   * The first release only reports, so a mistake in the tool-to-scope map cannot lock
   * anyone out of a tool they used yesterday.
   */
  it('reports but allows while in warn mode', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'warn';
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') });
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'delete_template');
    await response.text();

    expect(response.status).toBe(200);
  });

  it('offers a template-read client only the tools it may call', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const listed = await fetch(url, {
      method: 'POST',
      headers: headers(token, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    const body = await listed.text();

    expect(body).toContain('get_templates');
    expect(body).toContain('get_status');
    expect(body).not.toContain('delete_template');
    expect(body).not.toContain('generate_document');
  });

  it('offers every tool to a token that carries no scopes', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.';
    const { url, sessionId } = await connect(token);

    const listed = await fetch(url, {
      method: 'POST',
      headers: headers(token, sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    const body = await listed.text();

    expect(body).toContain('delete_workspace');
  });
});
