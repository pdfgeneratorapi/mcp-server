import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');
const { InvalidTokenError } = await import('../auth/errors.js');
const { REQUEST_MESSAGE } = await import('../telemetry.js');

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });

const WORKSPACE_ID = 42;
const ORGANIZATION_ID = 9;
const CLIENT = { name: 'Claude Code', version: '2.1.286' };
const PROTOCOL_VERSION = '2025-06-18';

/** The token names the scopes it grants, with ~ for the colon a bearer token cannot hold. */
const verifier = {
  verify: async (token: string): Promise<AuthInfo> => {
    if (token === 'invalid') {
      throw new InvalidTokenError('test');
    }
    const [sub, clientId, scopes = ''] = token.split('.');
    return {
      token,
      clientId,
      scopes: scopes === '' ? [] : scopes.split('+').map(scope => scope.replace('~', ':')),
      expiresAt: Math.floor(Date.now() / 1000) + 1800,
      extra: { sub, workspaceId: WORKSPACE_ID, organizationId: ORGANIZATION_ID, jti: token },
    };
  },
};

const credentials = { get: async () => 'upstream-token', invalidate: () => {} };

const servers: Array<{ close: () => void }> = [];
const previousMode = process.env.MCP_SCOPE_ENFORCEMENT;
let output: string[] = [];

beforeEach(() => {
  output = [];
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
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

/** The request log lines written so far, parsed. */
function requestLines(): Array<Record<string, any>> {
  return output
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line))
    .filter(line => line.message === REQUEST_MESSAGE)
    .map(line => line.context);
}

function headers(token?: string, sessionId?: string) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function start() {
  const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
  servers.push(app.server);

  return `http://localhost:${app.port}/mcp`;
}

async function connect(token: string) {
  const url = await start();
  const init = await fetch(url, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id') as string;
  await init.text();

  return { url, sessionId };
}

async function post(url: string, token: string | undefined, sessionId: string | undefined, message: object) {
  const response = await fetch(url, { method: 'POST', headers: headers(token, sessionId), body: JSON.stringify(message) });
  await response.text();

  return response;
}

function callTool(url: string, token: string, sessionId: string, name: string, args: object = {}) {
  return post(url, token, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
}

describe('request telemetry', () => {
  it('logs who opened a session, with which client and protocol', async () => {
    await connect('user-7.client-1');

    expect(requestLines()).toEqual([expect.objectContaining({
      credential: 'oauth',
      client_id: 'client-1',
      user_id: 'user-7',
      workspace_id: WORKSPACE_ID,
      organization_id: ORGANIZATION_ID,
      client_name: CLIENT.name,
      client_version: CLIENT.version,
      protocol_version: PROTOCOL_VERSION,
      http_method: 'POST',
      method: 'initialize',
      status: 200,
      outcome: 'ok',
    })]);
  });

  it('carries the client of the session onto its later requests', async () => {
    const token = 'user-7.client-1';
    const { url, sessionId } = await connect(token);

    await post(url, token, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(requestLines()[1]).toEqual(expect.objectContaining({
      method: 'tools/list',
      client_name: CLIENT.name,
      protocol_version: PROTOCOL_VERSION,
      outcome: 'ok',
    }));
  });

  it('logs a tool call once, with its outcome and the API status', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":[]}') });
    const token = 'user-7.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    await callTool(url, token, sessionId, 'get_templates');

    const calls = requestLines().filter(line => line.method === 'tools/call');
    expect(calls).toEqual([expect.objectContaining({
      workspace_id: WORKSPACE_ID,
      client_name: CLIENT.name,
      tool: 'get_templates',
      outcome: 'ok',
      upstream_status: 200,
      duration_ms: expect.any(Number),
    })]);
  });

  it('logs the API status of a failed tool call', async () => {
    mockAxios.mockRejectedValue({ isAxiosError: true, response: { status: 404, statusText: 'Not Found', data: Buffer.from('{}') } });
    const token = 'user-7.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    await callTool(url, token, sessionId, 'get_template', { templateId: 1 });

    expect(requestLines().find(line => line.method === 'tools/call')).toEqual(expect.objectContaining({
      tool: 'get_template',
      outcome: 'error',
      upstream_status: 404,
    }));
  });

  /**
   * Tool arguments carry customer data and the token is a credential: neither may reach
   * the logs, whatever else a request line holds.
   */
  it('never logs the token or the tool arguments', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{}') });
    const token = 'user-7.client-1.templates~write';
    const argument = 'Quarterly invoice for a customer';
    const { url, sessionId } = await connect(token);

    await callTool(url, token, sessionId, 'update_template', { templateId: 1, requestBody: { name: argument } });

    const lines = output.filter(line => line.includes(REQUEST_MESSAGE)).join('\n');
    expect(lines).toContain('update_template');
    expect(lines).not.toContain(token);
    expect(lines).not.toContain(argument);
  });

  it('logs a call refused for a missing scope as a refusal', async () => {
    process.env.MCP_SCOPE_ENFORCEMENT = 'enforce';
    const token = 'user-7.client-1.templates~read';
    const { url, sessionId } = await connect(token);

    await callTool(url, token, sessionId, 'delete_template', { templateId: 1 });

    expect(requestLines().filter(line => line.method === 'tools/call')).toEqual([expect.objectContaining({
      tool: 'delete_template',
      status: 403,
      outcome: 'refused',
      refusal: 'insufficient_scope',
    })]);
  });

  it('logs a request without a token', async () => {
    const url = await start();

    await post(url, undefined, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(requestLines()).toEqual([expect.objectContaining({
      credential: 'none',
      status: 401,
      outcome: 'refused',
      refusal: 'missing_token',
    })]);
  });

  it('logs a request with a token that does not verify', async () => {
    const url = await start();

    await post(url, 'invalid', undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    expect(requestLines()).toEqual([expect.objectContaining({
      credential: 'none',
      status: 401,
      refusal: 'invalid_token',
    })]);
  });

  it('logs a request for a session the caller does not own', async () => {
    const { url, sessionId } = await connect('user-7.client-1');

    await post(url, 'user-8.client-1', sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(requestLines()[1]).toEqual(expect.objectContaining({
      user_id: 'user-8',
      method: 'tools/list',
      status: 404,
      refusal: 'unknown_session',
    }));
    expect(requestLines()[1].client_name).toBeUndefined();
  });
});
