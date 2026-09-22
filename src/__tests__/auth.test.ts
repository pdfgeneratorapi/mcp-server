import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: Object.assign(jest.fn(), {
    isAxiosError: (e: any) => !!e.isAxiosError,
  }),
  __esModule: true,
}));

const { loadAuthConfig } = await import('../auth/config.js');
const { buildProtectedResourceMetadata } = await import('../auth/protectedResourceMetadata.js');
const { challenges } = await import('../auth/challenges.js');
const { createHttpApp } = await import('../streamable-http.js');
const { InvalidTokenError, AuthorizationServerUnavailableError } = await import('../auth/errors.js');

const RESOURCE = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test';
const METADATA_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';

const config = loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER });

const acceptingVerifier = {
  verify: async (token: string) => ({ token, clientId: '17', scopes: [], extra: { sub: '4821', workspaceId: 4821 } }),
};

describe('loadAuthConfig', () => {
  it('defaults to the production resource and issuer', () => {
    const defaults = loadAuthConfig({});

    expect(defaults.resource).toBe('https://mcp.pdfgeneratorapi.com/mcp');
    expect(defaults.issuer).toBe('https://auth.pdfgeneratorapi.com');
    expect(defaults.resourceMetadataUrl).toBe('https://mcp.pdfgeneratorapi.com/.well-known/oauth-protected-resource/mcp');
  });

  it('keeps the configured values byte for byte', () => {
    expect(config.resource).toBe(RESOURCE);
    expect(config.issuer).toBe(ISSUER);
  });

  it.each([
    ['a resource at a path', 'https://mcp.example.test/mcp', '/.well-known/oauth-protected-resource/mcp'],
    ['a resource at the root', 'https://mcp.example.test', '/.well-known/oauth-protected-resource'],
    ['a resource at a nested path', 'https://mcp.example.test/v2/mcp', '/.well-known/oauth-protected-resource/v2/mcp'],
  ])('inserts the well-known path before %s', (_label, resource, path) => {
    const derived = loadAuthConfig({ MCP_RESOURCE_URL: resource, OAUTH_ISSUER: ISSUER });

    expect(derived.resourceMetadataPath).toBe(path);
    expect(derived.resourceMetadataUrl).toBe(`https://mcp.example.test${path}`);
  });

  it.each([
    ['http://localhost:3000/mcp'],
    ['http://127.0.0.1:3000/mcp'],
    ['http://[::1]:3000/mcp'],
  ])('accepts plain http on loopback: %s', (resource) => {
    expect(loadAuthConfig({ MCP_RESOURCE_URL: resource, OAUTH_ISSUER: ISSUER }).resource).toBe(resource);
  });

  it.each([
    ['plain http to a public host', 'http://mcp.example.test/mcp'],
    ['a fragment', 'https://mcp.example.test/mcp#part'],
    ['a query', 'https://mcp.example.test/mcp?x=1'],
    ['a relative value', '/mcp'],
    ['an empty value', ''],
  ])('refuses to start with a resource carrying %s', (_label, resource) => {
    expect(() => loadAuthConfig({ MCP_RESOURCE_URL: resource, OAUTH_ISSUER: ISSUER })).toThrow(/MCP_RESOURCE_URL/);
  });

  it('discovers the signing keys unless OAUTH_JWKS_URI overrides them', () => {
    const jwksUri = 'https://keys.example.test/jwks.json';

    expect(config.jwksUri).toBeUndefined();
    expect(loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER, OAUTH_JWKS_URI: jwksUri }).jwksUri).toBe(jwksUri);
  });

  it('reaches the api credential endpoint in-cluster unless MCP_CREDENTIALS_URL overrides it', () => {
    const credentialsUrl = 'http://pdf-api-main-tenant/internal/mcp/credentials';

    expect(config.credentialsUrl).toBe('http://pdf-api-main/internal/mcp/credentials');
    expect(loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER, MCP_CREDENTIALS_URL: credentialsUrl }).credentialsUrl)
      .toBe(credentialsUrl);
  });

  it.each([
    ['a relative value', '/internal/mcp/credentials'],
    ['another scheme', 'ftp://pdf-api-main/internal/mcp/credentials'],
    ['credentials', 'http://user:pass@pdf-api-main/internal/mcp/credentials'],
  ])('refuses to start with a credentials URL carrying %s', (_label, credentialsUrl) => {
    expect(() => loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER, MCP_CREDENTIALS_URL: credentialsUrl }))
      .toThrow(/MCP_CREDENTIALS_URL/);
  });

  it('refuses to start with a JWKS override over plain http to a public host', () => {
    expect(() => loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER, OAUTH_JWKS_URI: 'http://keys.example.test/jwks.json' }))
      .toThrow(/OAUTH_JWKS_URI/);
  });

  it.each([
    ['plain http to a public host', 'http://auth.example.test'],
    ['a trailing slash', 'https://auth.example.test/'],
    ['a query', 'https://auth.example.test?x=1'],
  ])('refuses to start with an issuer carrying %s', (_label, issuer) => {
    expect(() => loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: issuer })).toThrow(/OAUTH_ISSUER/);
  });
});

describe('buildProtectedResourceMetadata', () => {
  it('names this resource and its authorization server', () => {
    expect(buildProtectedResourceMetadata(config)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      resource_name: 'PDF Generator API',
    });
  });

  it('never advertises offline_access or an empty scope list', () => {
    expect(buildProtectedResourceMetadata(config)).not.toHaveProperty('scopes_supported');
  });
});

/**
 * The WWW-Authenticate values are a wire contract clients parse, so every case is
 * compared as a whole string.
 */
describe('challenges', () => {
  it.each([
    [
      'missing credentials',
      () => challenges.missingCredentials(METADATA_URL),
      401,
      `Bearer resource_metadata="${METADATA_URL}"`,
    ],
    [
      'a malformed Authorization header',
      () => challenges.invalidRequest(METADATA_URL),
      401,
      `Bearer error="invalid_request", error_description="The Authorization header must be a Bearer token", resource_metadata="${METADATA_URL}"`,
    ],
    [
      'an invalid, expired or foreign token',
      () => challenges.invalidToken(METADATA_URL),
      401,
      `Bearer error="invalid_token", error_description="The access token is not valid", resource_metadata="${METADATA_URL}"`,
    ],
    [
      'insufficient scope',
      () => challenges.insufficientScope(METADATA_URL, ['templates:read', 'documents:write']),
      403,
      `Bearer error="insufficient_scope", scope="templates:read documents:write", error_description="The access token does not grant the required scope", resource_metadata="${METADATA_URL}"`,
    ],
  ])('answers %s', (_label, build, status, header) => {
    const challenge = build();

    expect(challenge.status).toBe(status);
    expect(challenge.wwwAuthenticate).toBe(header);
  });

  it('carries no error code when no credentials were sent (RFC 6750 §3.1)', () => {
    expect(challenges.missingCredentials(METADATA_URL).body).not.toHaveProperty('error');
  });

  it.each([
    ['invalid_request', () => challenges.invalidRequest(METADATA_URL)],
    ['invalid_token', () => challenges.invalidToken(METADATA_URL)],
    ['insufficient_scope', () => challenges.insufficientScope(METADATA_URL, ['templates:read'])],
  ])('answers %s with an OAuth error object', (error, build) => {
    const body = build().body;

    expect(body.error).toBe(error);
    expect(typeof body.error_description).toBe('string');
  });
});

describe('HTTP app', () => {
  const app = createHttpApp(config, acceptingVerifier);

  it.each([
    ['the path-inserted form', '/.well-known/oauth-protected-resource/mcp'],
    ['the root form', '/.well-known/oauth-protected-resource'],
  ])('serves the protected resource metadata at %s', async (_label, path) => {
    const res = await app.request(path);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual(buildProtectedResourceMetadata(config));
  });

  it('answers an unknown well-known path with a JSON 404, never the static site', async () => {
    const res = await app.request('/.well-known/openid-configuration');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('serves the health check without credentials', async () => {
    expect((await app.request('/health')).status).toBe(200);
  });

  it('challenges a request to /mcp without credentials', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}' });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it.each([
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a scheme without a token', 'Bearer'],
    ['a token with spaces', 'Bearer abc def'],
    ['an empty header', ''],
  ])('rejects %s as a malformed request', async (_label, authorization) => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}', headers: { Authorization: authorization } });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(challenges.invalidRequest(METADATA_URL).wwwAuthenticate);
  });

  it('lets a well-formed bearer token through to the MCP handler', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}', headers: { Authorization: 'bearer abc.def-ghi_jkl~' } });

    expect(res.status).not.toBe(401);
  });

  it('challenges a token the verifier rejects, whatever the reason', async () => {
    const rejecting = createHttpApp(config, { verify: async () => { throw new InvalidTokenError('expired'); } });

    const res = await rejecting.request('/mcp', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer abc.def.ghi' } });

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(challenges.invalidToken(METADATA_URL).wwwAuthenticate);
    expect(await res.json()).toEqual(challenges.invalidToken(METADATA_URL).body);
  });

  /**
   * A 401 here would send clients into a new login that cannot succeed either.
   */
  it('answers 503 when the authorization server cannot be reached', async () => {
    const unavailable = createHttpApp(config, {
      verify: async () => { throw new AuthorizationServerUnavailableError('jwks unreachable'); },
    });

    const res = await unavailable.request('/mcp', { method: 'POST', body: '{}', headers: { Authorization: 'Bearer abc.def.ghi' } });

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(res.headers.get('www-authenticate')).toBeNull();
    expect((await res.json()).error).toBe('temporarily_unavailable');
  });

  it('lets browser clients read the challenge and the session id', async () => {
    const res = await app.request('/mcp', { method: 'POST', body: '{}', headers: { Origin: 'https://client.example.test' } });

    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('www-authenticate');
    expect(exposed).toContain('mcp-session-id');
  });
});
