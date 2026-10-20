import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/server';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

// The logger reads its level once, on import
process.env.LOG_LEVEL = 'debug';

const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');
const { REQUEST_MESSAGE } = await import('../telemetry.js');

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });

const MODERN = '2026-07-28';
const CLIENT = { name: 'modern-client', version: '1.2.3' };
const ok = { status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":{"status":"ok"}}') };

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

const servers: Array<{ close: () => void }> = [];
const clients: Array<{ close: () => Promise<void> }> = [];
const previousMode = process.env.MCP_SCOPE_ENFORCEMENT;
let output: string[] = [];
let credentials: { get: jest.Mock<any>; invalidate: () => void };

beforeEach(() => {
  output = [];
  credentials = { get: jest.fn(async () => 'upstream-token'), invalidate: () => {} };
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => {});
  }
  for (const server of servers.splice(0)) {
    server.close();
  }
  jest.restoreAllMocks();
  mockAxios.mockReset();
  if (previousMode === undefined) {
    delete process.env.MCP_SCOPE_ENFORCEMENT;
  } else {
    process.env.MCP_SCOPE_ENFORCEMENT = previousMode;
  }
});

async function start() {
  const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
  servers.push(app.server);

  return `http://localhost:${app.port}/mcp`;
}

async function connect(token: string, mode: 'legacy' | 'auto' | { pin: string }) {
  const url = await start();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(CLIENT, { versionNegotiation: { mode } });
  await client.connect(transport);
  clients.push(client);

  return { url, client, transport };
}

/** A 2026-07-28 request as a client sends it: the envelope in `_meta` and the standard headers. */
function modernPost(url: string, token: string, method: string, params: Record<string, unknown> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
      'MCP-Protocol-Version': MODERN,
      'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientInfo': CLIENT,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

/** The request log lines written so far, parsed. */
function requestLines(): Array<Record<string, any>> {
  return output
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(line => line.message === REQUEST_MESSAGE)
    .map(line => line.context);
}

describe('the 2026-07-28 revision', () => {
  it('serves a client pinned to it without a session', async () => {
    mockAxios.mockResolvedValue(ok);
    const { client, transport } = await connect('user-1.client-1', { pin: MODERN });

    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    expect(client.getProtocolEra()).toBe('modern');
    expect(transport.sessionId).toBeUndefined();

    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toContain('get_status');

    const result = await client.callTool({ name: 'get_status', arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it('is what a negotiating client settles on', async () => {
    const { client } = await connect('user-1.client-1', 'auto');

    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
  });

  it('calls the API with the credential of the verified token on every request', async () => {
    mockAxios.mockResolvedValue(ok);
    const { client } = await connect('user-1.client-1', { pin: MODERN });

    await client.callTool({ name: 'get_status', arguments: {} });
    await client.callTool({ name: 'get_status', arguments: {} });

    expect(credentials.get).toHaveBeenCalledTimes(2);
    expect(credentials.get).toHaveBeenCalledWith(expect.objectContaining({ token: 'user-1.client-1', clientId: 'client-1' }));
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer upstream-token' }),
    }));
  });

  it('lists only the tools the grant covers', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const { client } = await connect('user-1.client-1.templates~read', { pin: MODERN });

    const names = (await client.listTools()).tools.map(tool => tool.name);

    expect(names).toContain('get_templates');
    expect(names).not.toContain('delete_template');
  });

  it('answers a call outside the grant with the step-up challenge', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const url = await start();

    const response = await modernPost(url, 'user-1.client-1.templates~read', 'tools/call', { name: 'delete_template', arguments: { templateId: 1 } });

    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"');
    expect(mockAxios).not.toHaveBeenCalled();
  });

  it('logs a tool call on one line with its client and outcome', async () => {
    mockAxios.mockResolvedValue(ok);
    const url = await start();

    const response = await modernPost(url, 'user-1.client-1', 'tools/call', { name: 'get_status', arguments: {} });
    await response.text();

    expect(response.status).toBe(200);
    expect(requestLines()).toEqual([expect.objectContaining({
      client_id: 'client-1',
      client_name: CLIENT.name,
      client_version: CLIENT.version,
      protocol_version: MODERN,
      method: 'tools/call',
      tool: 'get_status',
      status: 200,
      outcome: 'ok',
      upstream_status: 200,
    })]);
  });

  it('says in the debug log that the request has no session', async () => {
    mockAxios.mockResolvedValue(ok);
    const url = await start();

    await (await modernPost(url, 'user-1.client-1', 'tools/call', { name: 'get_status', arguments: {} })).text();

    expect(output).toContain(`POST tools/call in protocol revision ${MODERN}, no session`);
    expect(output.filter(line => line.includes('session ID'))).toEqual([]);
  });
});

describe('2025-era clients', () => {
  it('still open a session', async () => {
    const { client, transport } = await connect('user-1.client-1', 'legacy');

    expect(client.getProtocolEra()).toBe('legacy');
    expect(transport.sessionId).toEqual(expect.any(String));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain('get_status');
    expect(output).toContain(`POST request received with session ID: ${transport.sessionId}`);
  });
});
