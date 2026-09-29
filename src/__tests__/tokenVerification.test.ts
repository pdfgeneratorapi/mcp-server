import { describe, it, expect, jest, beforeAll } from '@jest/globals';
import {
  base64url,
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

const { createTokenVerifier, ORGANIZATION_CLAIM, WORKSPACE_CLAIM } = await import('../auth/verifier.js');
const { discoverJwksUri, createRemoteKeySetProvider } = await import('../auth/asMetadata.js');
const { InvalidTokenError, AuthorizationServerUnavailableError } = await import('../auth/errors.js');
const { loadAuthConfig } = await import('../auth/config.js');

const ISSUER = 'https://auth.example.test';
const RESOURCE = 'https://mcp.example.test/mcp';
const KID = 'signing-key';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let signingKey: PrivateKey;
let publicJwk: JWK;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  keySet = createLocalJWKSet({ keys: [publicJwk] });
});

function verifier(getKeySet: () => Promise<JWTVerifyGetKey> = async () => keySet) {
  return createTokenVerifier({ issuer: ISSUER, audience: RESOURCE, keySet: getKeySet });
}

function claims(overrides: JWTPayload = {}): JWTPayload {
  return {
    iss: ISSUER,
    aud: RESOURCE,
    sub: '4821',
    jti: 'token-id',
    client_id: '17',
    [WORKSPACE_CLAIM]: 4821,
    scopes: [],
    ...overrides,
  };
}

async function sign(payload: JWTPayload, options: { key?: PrivateKey; kid?: string; expiresIn?: string | number; notBefore?: string | number } = {}) {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? KID })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '30m');

  if (options.notBefore !== undefined) {
    jwt.setNotBefore(options.notBefore);
  }

  return jwt.sign(options.key ?? signingKey);
}

function withoutClaim(name: string): JWTPayload {
  const payload = claims();
  delete payload[name];
  return payload;
}

describe('createTokenVerifier', () => {
  it('accepts a token issued for this resource and describes it', async () => {
    const token = await sign(claims({ scopes: ['templates:read'] }));

    const authInfo = await verifier().verify(token);

    expect(authInfo.token).toBe(token);
    expect(authInfo.clientId).toBe('17');
    expect(authInfo.scopes).toEqual(['templates:read']);
    expect(authInfo.resource?.href).toBe(RESOURCE);
    expect(typeof authInfo.expiresAt).toBe('number');
    expect(authInfo.extra).toEqual({ sub: '4821', workspaceId: 4821, jti: 'token-id' });
  });

  it('reads the organization the grant was approved in', async () => {
    const authInfo = await verifier().verify(await sign(claims({ [ORGANIZATION_CLAIM]: 77 })));

    expect(authInfo.extra?.organizationId).toBe(77);
  });

  /**
   * Grants approved before the organization was recorded carry no claim and keep working.
   */
  it('accepts a token without an organization claim', async () => {
    const authInfo = await verifier().verify(await sign(claims()));

    expect(authInfo.extra?.organizationId).toBeUndefined();
  });

  it.each([
    ['another audience', async () => sign(claims({ aud: 'https://other.example.test/mcp' }))],
    ['an audience list, even one naming this resource', async () => sign(claims({ aud: [RESOURCE, 'https://other.example.test'] }))],
    ['another issuer', async () => sign(claims({ iss: 'https://evil.example.test' }))],
    ['an issuer with a trailing slash', async () => sign(claims({ iss: `${ISSUER}/` }))],
    ['an expired token', async () => sign(claims(), { expiresIn: Math.floor(Date.now() / 1000) - 60 })],
    ['a token not valid yet', async () => sign(claims(), { notBefore: '10m' })],
    ['an unknown key', async () => {
      const other = await generateKeyPair('RS256');
      return sign(claims(), { key: other.privateKey, kid: 'unknown-key' });
    }],
    ['a known kid with a signature from another key', async () => {
      const other = await generateKeyPair('RS256');
      return sign(claims(), { key: other.privateKey });
    }],
    ['no client_id', async () => sign(withoutClaim('client_id'))],
    ['no subject', async () => sign(withoutClaim('sub'))],
    ['no workspace claim', async () => sign(withoutClaim(WORKSPACE_CLAIM))],
    ['a workspace claim that is not an integer', async () => sign(claims({ [WORKSPACE_CLAIM]: '4821' }))],
    ['an organization claim that is text', async () => sign(claims({ [ORGANIZATION_CLAIM]: '77' }))],
    ['an organization claim of zero', async () => sign(claims({ [ORGANIZATION_CLAIM]: 0 }))],
    ['a negative organization claim', async () => sign(claims({ [ORGANIZATION_CLAIM]: -77 }))],
    ['a fractional organization claim', async () => sign(claims({ [ORGANIZATION_CLAIM]: 7.5 }))],
    ['HS256 signed with the RSA modulus as the HMAC key', async () => {
      const modulus = base64url.decode(publicJwk.n as string);
      return new SignJWT(claims()).setProtectedHeader({ alg: 'HS256', kid: KID }).setExpirationTime('30m').sign(modulus);
    }],
    ['alg none', async () => {
      const header = base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = base64url.encode(JSON.stringify({ ...claims(), exp: Math.floor(Date.now() / 1000) + 600 }));
      return `${header}.${body}.`;
    }],
    ['something that is not a JWT', async () => 'not-a-jwt'],
  ])('rejects %s as an invalid token', async (_label, token) => {
    await expect(verifier().verify(await token())).rejects.toBeInstanceOf(InvalidTokenError);
  });

  /**
   * Cheap checks come first, so a flood of forged tokens never reaches the key set,
   * which may mean a network fetch.
   */
  it.each([
    ['a foreign issuer', async () => sign(claims({ iss: 'https://evil.example.test' }))],
    ['a non-RS256 algorithm', async () => new SignJWT(claims()).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('30m').sign(new Uint8Array(32))],
  ])('rejects %s without resolving the key set', async (_label, token) => {
    const getKeySet = jest.fn(async () => keySet);

    await expect(verifier(getKeySet).verify(await token())).rejects.toBeInstanceOf(InvalidTokenError);
    expect(getKeySet).not.toHaveBeenCalled();
  });

  it('reports an unreachable authorization server rather than a bad token', async () => {
    const unavailable = async () => { throw new AuthorizationServerUnavailableError('metadata unreachable'); };

    await expect(verifier(unavailable).verify(await sign(claims()))).rejects.toBeInstanceOf(AuthorizationServerUnavailableError);
  });

  it.each([
    ['a JWKS timeout', () => new errors.JWKSTimeout()],
    ['an invalid JWKS response', () => new errors.JWKSInvalid()],
    ['a network failure', () => new TypeError('fetch failed')],
  ])('treats %s while fetching keys as the server being unavailable', async (_label, error) => {
    const failing: JWTVerifyGetKey = async () => { throw error(); };

    await expect(verifier(async () => failing).verify(await sign(claims()))).rejects.toBeInstanceOf(AuthorizationServerUnavailableError);
  });
});

describe('discoverJwksUri', () => {
  const config = loadAuthConfig({ MCP_RESOURCE_URL: RESOURCE, OAUTH_ISSUER: ISSUER });
  const jwksUri = `${ISSUER}/.well-known/jwks.json`;

  function metadataResponse(document: Record<string, unknown>, status = 200) {
    return jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(document), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  const document = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    response_types_supported: ['code'],
    jwks_uri: jwksUri,
  };

  it('reads jwks_uri from the authorization server metadata', async () => {
    const fetch = metadataResponse(document);

    await expect(discoverJwksUri(config, fetch)).resolves.toBe(jwksUri);
    expect(fetch.mock.calls[0][0]).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  it('refuses metadata naming another issuer', async () => {
    await expect(discoverJwksUri(config, metadataResponse({ ...document, issuer: `${ISSUER}/` })))
      .rejects.toThrow(/issuer/);
  });

  it.each([
    ['an error status', () => metadataResponse(document, 503)],
    ['metadata without jwks_uri', () => metadataResponse({ ...document, jwks_uri: undefined })],
    ['a network failure', () => jest.fn(async () => { throw new TypeError('fetch failed'); })],
  ])('reports the server unavailable on %s', async (_label, fetch) => {
    await expect(discoverJwksUri(config, fetch())).rejects.toBeInstanceOf(AuthorizationServerUnavailableError);
  });

  it('uses the configured JWKS URI without fetching the metadata', async () => {
    const override = 'https://keys.example.test/jwks.json';
    const fetch = metadataResponse(document);

    await expect(discoverJwksUri({ ...config, jwksUri: override }, fetch)).resolves.toBe(override);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discovers the key set once and keeps it', async () => {
    const fetch = metadataResponse(document);
    const provider = createRemoteKeySetProvider(config, fetch);

    const first = await provider();
    const second = await provider();

    expect(first).toBe(second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('tries the discovery again after a failure', async () => {
    const fetch = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('', { status: 503 }));
    const provider = createRemoteKeySetProvider(config, fetch);

    await expect(provider()).rejects.toBeInstanceOf(AuthorizationServerUnavailableError);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify(document), { status: 200 }));
    await expect(provider()).resolves.toBeDefined();
  });
});
