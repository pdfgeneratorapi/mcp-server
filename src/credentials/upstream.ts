/**
 * Credentials for calling the PDF Generator API on a user's behalf. The client's own
 * access token is never one of them: it is issued for this server, not for the API.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface UpstreamCredentials {
  /** A credential for the API, for the grant behind the verified client token. */
  get(authInfo: AuthInfo | undefined): Promise<string>;
  /** Forgets the credential for this grant, after the API rejected it. */
  invalidate(authInfo: AuthInfo | undefined): void;
}

export class UpstreamCredentialError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamCredentialError';
  }
}

export interface MintedCredentialsOptions {
  /** The api's internal credential endpoint. */
  url: string;
  /** The authorization server issuer, part of the cache key. */
  issuer: string;
  fetch?: Fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

interface CachedCredential {
  token: string;
  expiresAt: number;
}

const REQUEST_TIMEOUT_MS = 5_000;
// Renew a little early so a credential never expires on its way to the API.
const EXPIRY_MARGIN_SECONDS = 30;
const MAX_CACHED_CREDENTIALS = 10_000;

/**
 * Credentials minted by the api for each grant. They are cached per grant, not per
 * client token, so a refreshed token reuses the credential, and concurrent calls for
 * one grant share a single request.
 */
export function createMintedCredentials(options: MintedCredentialsOptions): UpstreamCredentials {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, CachedCredential>();
  const pending = new Map<string, Promise<string>>();

  const nowSeconds = () => Math.floor(now() / 1000);

  function keyOf(authInfo: AuthInfo): string {
    return JSON.stringify([
      options.issuer,
      authInfo.extra?.sub,
      authInfo.clientId,
      authInfo.extra?.organizationId ?? null,
      [...authInfo.scopes].sort(),
      authInfo.resource?.href,
    ]);
  }

  function prune(): void {
    if (cache.size < MAX_CACHED_CREDENTIALS) {
      return;
    }

    const current = nowSeconds();
    for (const [key, credential] of cache) {
      if (credential.expiresAt - EXPIRY_MARGIN_SECONDS <= current) {
        cache.delete(key);
      }
    }
  }

  async function mint(authInfo: AuthInfo): Promise<CachedCredential> {
    const accessTokenId = authInfo.extra?.jti;
    const userId = Number(authInfo.extra?.sub);
    let response: Response;

    try {
      response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ access_token_id: accessTokenId, user_id: userId, client_id: authInfo.clientId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new UpstreamCredentialError('The API credential service cannot be reached', undefined, undefined, { cause: error });
    }

    const body = await response.json().catch(() => ({})) as Record<string, unknown>;

    if (!response.ok) {
      const description = typeof body.error_description === 'string' ? body.error_description : `status ${response.status}`;
      const code = typeof body.error === 'string' ? body.error : undefined;
      throw new UpstreamCredentialError(`No API credential for this connection: ${description}`, response.status, code);
    }

    if (typeof body.access_token !== 'string' || typeof body.expires_at !== 'number') {
      throw new UpstreamCredentialError('The API credential service answered without a credential', response.status);
    }

    return {
      token: body.access_token,
      // Never outlive the client token that justified the credential.
      expiresAt: Math.min(body.expires_at, authInfo.expiresAt ?? body.expires_at),
    };
  }

  return {
    async get(authInfo) {
      if (!authInfo || typeof authInfo.extra?.jti !== 'string' || typeof authInfo.extra?.sub !== 'string') {
        throw new UpstreamCredentialError('No verified access token for this request');
      }

      const key = keyOf(authInfo);
      const cached = cache.get(key);

      if (cached && cached.expiresAt - EXPIRY_MARGIN_SECONDS > nowSeconds()) {
        return cached.token;
      }

      let request = pending.get(key);

      if (!request) {
        request = mint(authInfo)
          .then((credential) => {
            prune();
            cache.set(key, credential);
            return credential.token;
          })
          .finally(() => pending.delete(key));
        pending.set(key, request);
      }

      return request;
    },

    invalidate(authInfo) {
      if (authInfo) {
        cache.delete(keyOf(authInfo));
      }
    },
  };
}

/**
 * A fixed credential, for local development and tests only.
 */
export function createStaticCredentials(token: string): UpstreamCredentials {
  return {
    async get() {
      return token;
    },
    invalidate() {
      // A fixed credential cannot be renewed.
    },
  };
}
