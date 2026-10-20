#!/usr/bin/env node
/**
 * Smoke test of a deployed MCP server: walks the flow an MCP client follows (challenge,
 * discovery, sign-in, both protocol eras, a tool call) and checks each step. See docs/clients.md.
 *
 *   MCP_URL           the MCP endpoint (default: staging)
 *   MCP_ACCESS_TOKEN  an access token to use instead of signing in
 *   API_BASE_URL      the API the access token must not be accepted by
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const MCP_URL = process.env.MCP_URL ?? 'https://mcp.staging.pdfgeneratorapi.com/mcp';
const API_BASE_URL = process.env.API_BASE_URL
  ?? (new URL(MCP_URL).hostname.includes('staging') ? 'https://staging.pdfgeneratorapi.com/api/v4' : 'https://us1.pdfgeneratorapi.com/api/v4');
const LEGACY_VERSION = '2025-11-25';
const MODERN_VERSION = '2026-07-28';
const CLIENT_INFO = { name: 'mcp-smoke-test', version: '1.0.0' };
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

let failures = 0;

async function step(name, check) {
  try {
    const detail = await check();
    console.log(`✓ ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    failures++;
    console.log(`✗ ${name}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const base64url = (buffer) => buffer.toString('base64url');

/** The JSON-RPC message of a response, sent as JSON or as a server-sent event stream. */
async function rpcResult(response) {
  const text = await response.text();
  const json = (response.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean).pop()
    : text;
  const message = JSON.parse(json ?? 'null');
  expect(message && !message.error, `JSON-RPC error: ${JSON.stringify(message?.error ?? message)}`);

  return message.result;
}

function mcpHeaders(token, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${token}`,
    ...extra,
  };
}

async function signIn(metadata, resourceMetadata) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  try {
    const registration = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'PDF Generator API MCP smoke test',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status === 201, `registration answered ${registration.status}`);
    const { client_id: clientId } = await registration.json();

    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      resource: MCP_URL,
      scope: (resourceMetadata.scopes_supported ?? []).join(' '),
    }).toString();

    console.log(`\nOpen this URL in a browser, sign in and allow the connection:\n\n${authorize}\n`);

    const callback = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sign-in within 5 minutes')), SIGN_IN_TIMEOUT_MS);
      server.on('request', (request, response) => {
        const url = new URL(request.url, redirectUri);

        if (url.pathname !== '/callback') {
          response.writeHead(404).end();
          return;
        }

        response.writeHead(200, { 'Content-Type': 'text/plain' }).end('Signed in. You can close this window.');
        clearTimeout(timer);
        resolve(url.searchParams);
      });
    });

    expect(!callback.get('error'), `authorization failed: ${callback.get('error')}`);
    expect(callback.get('state') === state, 'the state does not match');
    expect(callback.get('iss') === metadata.issuer, `iss is "${callback.get('iss')}", not "${metadata.issuer}"`);

    const token = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.get('code'),
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP_URL,
      }),
    });
    const tokens = await token.json();
    expect(token.status === 200, `token endpoint answered ${token.status}: ${JSON.stringify(tokens)}`);

    return { clientId, ...tokens };
  } finally {
    server.close();
  }
}

console.log(`Smoke test of ${MCP_URL}\n`);

let resourceMetadataUrl;
let resourceMetadata;
let metadata;
let accessToken = process.env.MCP_ACCESS_TOKEN;
let grant;

await step('an unauthenticated request is challenged', async () => {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
  });
  expect(response.status === 401, `answered ${response.status}`);
  resourceMetadataUrl = /resource_metadata="([^"]+)"/.exec(response.headers.get('www-authenticate') ?? '')?.[1];
  expect(resourceMetadataUrl, 'the challenge names no resource_metadata');

  return resourceMetadataUrl;
});

await step('the protected resource metadata names this server and an authorization server', async () => {
  resourceMetadata = await (await fetch(resourceMetadataUrl)).json();
  expect(resourceMetadata.resource === MCP_URL, `resource is "${resourceMetadata.resource}"`);
  expect(resourceMetadata.authorization_servers?.length > 0, 'no authorization_servers');

  return resourceMetadata.authorization_servers[0];
});

await step('the authorization server metadata supports what clients need', async () => {
  const issuer = resourceMetadata.authorization_servers[0];
  metadata = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  expect(metadata.issuer === issuer, `issuer is "${metadata.issuer}"`);
  expect(metadata.code_challenge_methods_supported?.includes('S256'), 'no S256');
  expect(metadata.registration_endpoint, 'no registration_endpoint');
  expect(metadata.revocation_endpoint, 'no revocation_endpoint');
  expect(metadata.client_id_metadata_document_supported === true, 'no Client ID Metadata Documents');
  expect(metadata.authorization_response_iss_parameter_supported === true, 'no iss parameter');
});

if (accessToken) {
  console.log('✓ signed in (MCP_ACCESS_TOKEN given)');
} else {
  await step('signs in with PKCE and resource', async () => {
    grant = await signIn(metadata, resourceMetadata);
    accessToken = grant.access_token;

    return `scope: ${grant.scope}`;
  });
}

if (accessToken) {
  await step(`a ${LEGACY_VERSION} client opens a session, lists the tools and calls get_status`, async () => {
    const opened = await fetch(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders(accessToken),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }),
    });
    expect(opened.status === 200, `initialize answered ${opened.status}`);
    const sessionId = opened.headers.get('mcp-session-id');
    expect(sessionId, 'no Mcp-Session-Id');
    const negotiated = (await rpcResult(opened)).protocolVersion;
    const session = mcpHeaders(accessToken, { 'mcp-session-id': sessionId, 'mcp-protocol-version': negotiated });

    await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const tools = await rpcResult(await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
    const call = await rpcResult(await fetch(MCP_URL, { method: 'POST', headers: session, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } }) }));
    expect(!call.isError, `get_status failed: ${call.content?.[0]?.text}`);
    const closed = await fetch(MCP_URL, { method: 'DELETE', headers: session });
    expect(closed.status === 204, `closing the session answered ${closed.status}`);

    return `${negotiated}, ${tools.tools.length} tools`;
  });

  await step(`a ${MODERN_VERSION} client discovers the server, lists the tools and calls get_status`, async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
      'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const request = (id, method, params = {}) => fetch(MCP_URL, {
      method: 'POST',
      headers: mcpHeaders(accessToken, {
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': method,
        ...(params.name ? { 'mcp-name': params.name } : {}),
      }),
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
    });

    const discovered = await request(1, 'server/discover');
    expect(discovered.status === 200, `server/discover answered ${discovered.status}`);
    expect(!discovered.headers.get('mcp-session-id'), 'a session was opened');
    expect((await rpcResult(discovered)).supportedVersions?.includes(MODERN_VERSION), `${MODERN_VERSION} is not supported`);
    const tools = await rpcResult(await request(2, 'tools/list'));
    const call = await rpcResult(await request(3, 'tools/call', { name: 'get_status', arguments: {} }));
    expect(!call.isError, `get_status failed: ${call.content?.[0]?.text}`);

    return `${tools.tools.length} tools`;
  });

  await step('the API refuses the access token, so tool calls used a credential issued for the grant', async () => {
    const response = await fetch(`${API_BASE_URL}/templates`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect([401, 403].includes(response.status), `${API_BASE_URL} answered ${response.status}`);

    return `${API_BASE_URL} answered ${response.status}`;
  });
}

if (grant) {
  await step('revokes the token it obtained', async () => {
    const response = await fetch(metadata.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: grant.refresh_token ?? grant.access_token, client_id: grant.clientId }),
    });
    expect(response.status === 200, `answered ${response.status}`);
  });
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
