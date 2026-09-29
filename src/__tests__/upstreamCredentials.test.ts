import { describe, it, expect, jest } from '@jest/globals';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const { createMintedCredentials, createStaticCredentials, UpstreamCredentialError } = await import('../credentials/upstream.js');

const CREDENTIALS_URL = 'http://pdf-api-main/internal/mcp/credentials';
const ISSUER = 'https://auth.example.test';
const NOW_SECONDS = 1_800_000_000;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function authInfo(
  overrides: Partial<AuthInfo> & { jti?: string; sub?: string; organizationId?: number } = {},
): AuthInfo {
  const { jti = 'token-id', sub = '4821', organizationId, ...rest } = overrides;

  return {
    token: 'client-token',
    clientId: '17',
    scopes: [],
    expiresAt: NOW_SECONDS + 1800,
    resource: new URL('https://mcp.example.test/mcp'),
    extra: { sub, workspaceId: Number(sub), organizationId, jti },
    ...rest,
  };
}

function minted(accessToken: string, expiresAt: number, status = 200) {
  return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_at: expiresAt }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function provider(fetch: Fetch, now: () => number = () => NOW_SECONDS * 1000) {
  return createMintedCredentials({ url: CREDENTIALS_URL, issuer: ISSUER, fetch, now });
}

describe('createMintedCredentials', () => {
  it('asks the api for a credential for the verified grant, never sending the client token', async () => {
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 300));

    await expect(provider(fetch).get(authInfo())).resolves.toBe('upstream-token');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(CREDENTIALS_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ access_token_id: 'token-id', user_id: 4821, client_id: '17' });
    expect(JSON.stringify(init)).not.toContain('client-token');
  });

  it('reuses the credential until shortly before it expires', async () => {
    let now = NOW_SECONDS * 1000;
    let mintedCount = 0;
    const fetch = jest.fn<Fetch>(async () => minted(`upstream-${++mintedCount}`, NOW_SECONDS + 300));
    const credentials = provider(fetch, () => now);

    await credentials.get(authInfo());
    now += 200_000;
    await credentials.get(authInfo());
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 80_000;
    await credentials.get(authInfo());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  /**
   * A refreshed client token has a new jti but the same grant, so it must not cost a
   * new credential.
   */
  it('shares one credential across client tokens of the same grant', async () => {
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 300));
    const credentials = provider(fetch);

    await credentials.get(authInfo({ jti: 'first' }));
    await credentials.get(authInfo({ jti: 'refreshed' }));

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another user', { sub: '99' }],
    ['another client', { clientId: '18' }],
    ['other scopes', { scopes: ['templates:read'] }],
    ['another organization of the same user and client', { organizationId: 20 }],
  ])('keeps a separate credential for %s', async (_label, overrides) => {
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 300));
    const credentials = provider(fetch);

    await credentials.get(authInfo());
    await credentials.get(authInfo(overrides));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  /**
   * A master user may connect the same client in two organizations; each organization's calls
   * must use the credential minted for its own grant.
   */
  it('never serves one organization the credential of another', async () => {
    const fetch = jest.fn<Fetch>()
      .mockResolvedValueOnce(minted('credential-for-10', NOW_SECONDS + 300))
      .mockResolvedValueOnce(minted('credential-for-20', NOW_SECONDS + 300));
    const credentials = provider(fetch);

    expect(await credentials.get(authInfo({ organizationId: 10 }))).toBe('credential-for-10');
    expect(await credentials.get(authInfo({ organizationId: 20, jti: 'other-grant' }))).toBe('credential-for-20');
    expect(await credentials.get(authInfo({ organizationId: 10, jti: 'refreshed' }))).toBe('credential-for-10');
  });

  it('keys the scopes regardless of their order', async () => {
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 300));
    const credentials = provider(fetch);

    await credentials.get(authInfo({ scopes: ['a', 'b'] }));
    await credentials.get(authInfo({ scopes: ['b', 'a'] }));

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('makes one request for ten concurrent calls', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = jest.fn<Fetch>(async () => {
      await gate;
      return minted('upstream-token', NOW_SECONDS + 300);
    });
    const credentials = provider(fetch);

    const calls = Array.from({ length: 10 }, () => credentials.get(authInfo()));
    release();

    await expect(Promise.all(calls)).resolves.toEqual(Array(10).fill('upstream-token'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never keeps a credential past the client token that justified it', async () => {
    let now = NOW_SECONDS * 1000;
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 3600));
    const credentials = provider(fetch, () => now);

    await credentials.get(authInfo({ expiresAt: NOW_SECONDS + 120 }));
    now += 120_000;
    await credentials.get(authInfo({ expiresAt: NOW_SECONDS + 1800 }));

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fetches a new credential after being told the last one was rejected', async () => {
    let mintedCount = 0;
    const fetch = jest.fn<Fetch>(async () => minted(`upstream-${++mintedCount}`, NOW_SECONDS + 300));
    const credentials = provider(fetch);

    const first = await credentials.get(authInfo());
    credentials.invalidate(authInfo());
    const second = await credentials.get(authInfo());

    expect(first).not.toBe(second);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a refusal with the api reason and message', async () => {
    const fetch = jest.fn<Fetch>(async () => new Response(
      JSON.stringify({ error: 'ambiguous_organization', error_description: 'Pick one organization.' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    ));

    const error = await provider(fetch).get(authInfo()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamCredentialError);
    expect((error as InstanceType<typeof UpstreamCredentialError>).status).toBe(409);
    expect((error as InstanceType<typeof UpstreamCredentialError>).code).toBe('ambiguous_organization');
    expect((error as Error).message).toContain('Pick one organization.');
  });

  it('does not keep a failure, so the next call tries again', async () => {
    const fetch = jest.fn<Fetch>(async () => { throw new TypeError('fetch failed'); });
    const credentials = provider(fetch);

    await expect(credentials.get(authInfo())).rejects.toBeInstanceOf(UpstreamCredentialError);
    fetch.mockResolvedValueOnce(minted('upstream-token', NOW_SECONDS + 300));
    await expect(credentials.get(authInfo())).resolves.toBe('upstream-token');
  });

  it('refuses to act without a verified token', async () => {
    const fetch = jest.fn<Fetch>(async () => minted('upstream-token', NOW_SECONDS + 300));

    await expect(provider(fetch).get(undefined)).rejects.toBeInstanceOf(UpstreamCredentialError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('createStaticCredentials', () => {
  it('always answers with the configured token', async () => {
    const credentials = createStaticCredentials('static-token');

    await expect(credentials.get(undefined)).resolves.toBe('static-token');
    credentials.invalidate(undefined);
    await expect(credentials.get(authInfo())).resolves.toBe('static-token');
  });
});
