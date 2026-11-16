import { describe, it, expect, jest, afterEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/server';

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
  mockAxios.mockReset();
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

function callTool(url: string, token: string, sessionId: string, name: string, args: Record<string, unknown> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: headers(token, sessionId),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
}

describe('scope enforcement over HTTP', () => {
  /**
   * Clients ask for exactly the scopes the challenge names, so a challenge naming only the
   * missing scope would leave the client with a grant that has only that scope.
   */
  it('asks for every scope the token already has, plus the missing one', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read+documents~read+forms~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'call_operation', {
      id: 'run_builder_tool',
      arguments: { template_id: 7, tool: 'rename_template' },
    });
    await response.text();

    expect(response.status).toBe(403);
    expect(/scope="([^"]*)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1])
      .toBe('templates:read documents:read forms:read templates:write');
  });

  it('answers a run of an operation outside the grant with the step-up challenge', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'call_operation', { id: 'delete_template', arguments: { templateId: 7 } });
    await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain('scope="templates:read templates:delete"');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('asks for templates:write to run a builder tool that changes the template through call_operation', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'call_operation', {
      id: 'run_builder_tool',
      arguments: { template_id: 7, tool: 'add_component' },
    });
    await response.text();

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="templates:read templates:write"');
  });

  it('lets a run of an operation the grant covers through', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":[]}') });
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const templates = await callTool(url, token, sessionId, 'read_operation', { id: 'get_templates' });
    const pages = await callTool(url, token, sessionId, 'read_operation', {
      id: 'run_builder_tool',
      arguments: { template_id: 7, tool: 'list_pages' },
    });
    await Promise.all([templates.text(), pages.text()]);

    expect([templates.status, pages.status]).toEqual([200, 200]);
    expect(mockAxios).toHaveBeenCalledTimes(2);
  });

  /** A client signing in again for the permission would then only hear the run needs the other tool. */
  it('tells a run sent to the wrong tool which one to use, before asking for a permission', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'read_operation', { id: 'delete_template', arguments: { templateId: 7 } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('\\"delete_template\\" changes data, so run it with call_operation.');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('answers a run of an unknown operation with a tool error', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'call_operation', { id: 'make_coffee' });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('There is no operation');
  });

  /**
   * The first release only reports, so a mistake in the tool-to-scope map cannot lock
   * anyone out of a tool they used yesterday.
   */
  it('reports but runs an operation outside the grant in warn mode', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'warn';
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') });
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'call_operation', { id: 'delete_template', arguments: { templateId: 7 } });
    await response.text();

    expect(response.status).toBe(200);
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('searches only what the grant covers', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-a.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    const response = await callTool(url, token, sessionId, 'search_operations', { query: 'delete template' });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('delete_template');
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
    expect(body).toContain('"name":"read_operation"');
    expect(body).not.toContain('"name":"call_operation"');
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
