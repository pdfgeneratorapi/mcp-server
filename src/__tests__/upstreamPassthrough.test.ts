import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { loadAuthConfig } = await import('../auth/config.js');

const CLIENT_TOKEN = 'client-access-token';
const UPSTREAM_TOKEN = 'minted-v4-credential';

const config = loadAuthConfig({ MCP_RESOURCE_URL: 'https://mcp.example.test/mcp', OAUTH_ISSUER: 'https://auth.example.test' });

const verifier = {
  verify: async (token: string): Promise<AuthInfo> => ({
    token,
    clientId: '17',
    scopes: [],
    expiresAt: Math.floor(Date.now() / 1000) + 1800,
    extra: { sub: '4821', workspaceId: 4821, jti: 'token-id' },
  }),
};

const JSON_RPC_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
  'Authorization': `Bearer ${CLIENT_TOKEN}`,
};

beforeEach(() => {
  mockAxios.mockReset();
  mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { status: 'ok' } });
});

type GetCredential = (authInfo: AuthInfo | undefined) => Promise<string>;

const servers: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const server of servers) {
    server.close();
  }
});

async function callTool(credentials: { get: jest.Mock<GetCredential>; invalidate: jest.Mock<() => void> }) {
  const app = await setupStreamableHttpServer(0, { authConfig: config, verifier, credentials });
  servers.push(app.server);
  const url = `http://localhost:${app.port}/mcp`;

  const init = await fetch(url, {
    method: 'POST',
    headers: JSON_RPC_HEADERS,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  });
  const sessionId = init.headers.get('mcp-session-id') as string;
  await init.text();

  const call = await fetch(url, {
    method: 'POST',
    headers: { ...JSON_RPC_HEADERS, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } }),
  });

  return call.text();
}

describe('upstream credentials', () => {
  /**
   * The MCP spec forbids passing the client's token through to upstream APIs.
   */
  it('never sends the client token to the API, only the upstream credential', async () => {
    const credentials = { get: jest.fn<GetCredential>(async () => UPSTREAM_TOKEN), invalidate: jest.fn<() => void>() };

    await callTool(credentials);

    expect(mockAxios).toHaveBeenCalledTimes(1);
    const outbound = JSON.stringify(mockAxios.mock.calls[0][0]);
    expect(outbound).not.toContain(CLIENT_TOKEN);
    expect((mockAxios.mock.calls[0][0] as any).headers.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
  });

  it('asks for the credential with the verified token of the request', async () => {
    const credentials = { get: jest.fn<GetCredential>(async () => UPSTREAM_TOKEN), invalidate: jest.fn<() => void>() };

    await callTool(credentials);

    const authInfo = credentials.get.mock.calls[0][0];
    expect(authInfo?.clientId).toBe('17');
    expect(authInfo?.extra).toEqual({ sub: '4821', workspaceId: 4821, jti: 'token-id' });
  });
});
