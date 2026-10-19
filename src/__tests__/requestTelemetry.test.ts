import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { setupStreamableHttpServer } = await import('../streamable-http.js');
const { REQUEST_MESSAGE } = await import('../telemetry.js');

const API_KEY = '61e5f04ca1794253ed17e6bb986c1702';
const WORKSPACE = 'workspace@example.test';
const THIRTY_DAYS = 30 * 24 * 60 * 60;
const CLIENT = { name: 'Claude Code', version: '2.1.286' };
const PROTOCOL_VERSION = '2025-06-18';

/** A hand-made v4 token: the API checks its signature, this server only reads it. */
function handMadeToken(claims: object = {}): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');

  return [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ iss: API_KEY, sub: WORKSPACE, iat: issuedAt, exp: issuedAt + THIRTY_DAYS, ...claims }),
    'signature',
  ].join('.');
}

const servers: Array<{ close: () => void }> = [];
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
  const app = await setupStreamableHttpServer(0);
  servers.push(app.server);

  return `http://localhost:${app.port}/mcp`;
}

async function connect(token?: string) {
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

function callTool(url: string, sessionId: string, name: string, args: object = {}) {
  return post(url, undefined, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
}

describe('request telemetry', () => {
  it('logs the workspace and API key a hand-made token names, and how long it lives', async () => {
    await connect(handMadeToken());

    expect(requestLines()).toEqual([expect.objectContaining({
      credential: 'legacy-jwt',
      workspace_identifier: WORKSPACE,
      api_key: API_KEY,
      token_lifetime_s: THIRTY_DAYS,
      client_name: CLIENT.name,
      client_version: CLIENT.version,
      protocol_version: PROTOCOL_VERSION,
      method: 'initialize',
      status: 200,
      outcome: 'ok',
    })]);
  });

  /**
   * A session keeps acting with the token it was opened with, whatever later requests
   * send, so that token is the one their log lines name.
   */
  it('names the token of the session on its later requests', async () => {
    const { url, sessionId } = await connect(handMadeToken());

    await post(url, handMadeToken({ sub: 'someone-else@example.test' }), sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(requestLines()[1]).toEqual(expect.objectContaining({
      method: 'tools/list',
      workspace_identifier: WORKSPACE,
      client_name: CLIENT.name,
    }));
  });

  it('logs a tool call once, with its outcome and the API status', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: { response: [] } });
    const { url, sessionId } = await connect(handMadeToken());

    await callTool(url, sessionId, 'get_templates');

    expect(requestLines().filter(line => line.method === 'tools/call')).toEqual([expect.objectContaining({
      workspace_identifier: WORKSPACE,
      client_name: CLIENT.name,
      tool: 'get_templates',
      outcome: 'ok',
      upstream_status: 200,
      duration_ms: expect.any(Number),
    })]);
  });

  it('logs the API status of a failed tool call', async () => {
    mockAxios.mockRejectedValue({ isAxiosError: true, response: { status: 401, statusText: 'Unauthorized', data: {} } });
    const { url, sessionId } = await connect(handMadeToken());

    await callTool(url, sessionId, 'get_template', { templateId: 1 });

    expect(requestLines().find(line => line.method === 'tools/call')).toEqual(expect.objectContaining({
      tool: 'get_template',
      outcome: 'error',
      upstream_status: 401,
    }));
  });

  /**
   * Tool arguments carry customer data and the token is a credential: neither may reach
   * the logs, whatever else a request line holds.
   */
  it('never logs the token or the tool arguments', async () => {
    mockAxios.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/json' }, data: {} });
    const token = handMadeToken();
    const argument = 'Quarterly invoice for a customer';
    const { url, sessionId } = await connect(token);

    await callTool(url, sessionId, 'update_template', { templateId: 1, requestBody: { name: argument } });

    const lines = output.filter(line => line.includes(REQUEST_MESSAGE)).join('\n');
    expect(lines).toContain('update_template');
    expect(lines).not.toContain(token);
    expect(lines).not.toContain(token.split('.')[2]);
    expect(lines).not.toContain(argument);
  });

  it('logs a session opened without a token', async () => {
    await connect();

    expect(requestLines()).toEqual([expect.objectContaining({ credential: 'none', method: 'initialize', status: 200 })]);
  });

  it('logs a request for a session that does not exist', async () => {
    const url = await start();

    await post(url, handMadeToken(), 'no-such-session', { jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(requestLines()).toEqual([expect.objectContaining({
      workspace_identifier: WORKSPACE,
      method: 'tools/list',
      status: 400,
      outcome: 'refused',
      refusal: 'unknown_session',
    })]);
  });
});
