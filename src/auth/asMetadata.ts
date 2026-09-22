/**
 * Finds the authorization server's signing keys through its RFC 8414 metadata.
 */
import { createRemoteJWKSet, customFetch, type JWTVerifyGetKey } from 'jose';
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthConfig } from './config.js';
import { AuthorizationServerUnavailableError } from './errors.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const METADATA_PATH = '/.well-known/oauth-authorization-server';
const METADATA_TIMEOUT_MS = 5_000;
const JWKS_TIMEOUT_MS = 5_000;
// Guards against a flood of tokens with unknown kids forcing a refetch each time.
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;

/**
 * The fetched metadata must name the configured issuer byte for byte, so a server
 * answering for another issuer can never supply our keys.
 */
export async function discoverJwksUri(config: AuthConfig, fetchImpl: Fetch = fetch): Promise<string> {
  if (config.jwksUri) {
    return config.jwksUri;
  }

  const url = `${config.issuer}${METADATA_PATH}`;
  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AuthorizationServerUnavailableError(`cannot fetch ${url}`, { cause: error });
  }

  if (!response.ok) {
    throw new AuthorizationServerUnavailableError(`${url} answered ${response.status}`);
  }

  const metadata = OAuthMetadataSchema.safeParse(await response.json().catch(() => undefined));

  if (!metadata.success) {
    throw new AuthorizationServerUnavailableError(`${url} is not valid authorization server metadata`);
  }

  if (metadata.data.issuer !== config.issuer) {
    throw new AuthorizationServerUnavailableError(
      `metadata issuer "${metadata.data.issuer}" does not match OAUTH_ISSUER "${config.issuer}"`,
    );
  }

  const jwksUri: unknown = metadata.data.jwks_uri;

  if (typeof jwksUri !== 'string' || jwksUri === '') {
    throw new AuthorizationServerUnavailableError(`${url} has no jwks_uri`);
  }

  return jwksUri;
}

/**
 * Returns the remote key set, discovering it on first use and keeping it for the life
 * of the process; jose handles caching and rotation from there. A failed discovery is
 * not kept, so the next request tries again.
 */
export function createRemoteKeySetProvider(config: AuthConfig, fetchImpl: Fetch = fetch): () => Promise<JWTVerifyGetKey> {
  let keySet: JWTVerifyGetKey | undefined;
  let pending: Promise<JWTVerifyGetKey> | undefined;

  return () => {
    if (keySet) {
      return Promise.resolve(keySet);
    }

    pending ??= discoverJwksUri(config, fetchImpl)
      .then((jwksUri) => {
        keySet = createRemoteJWKSet(new URL(jwksUri), {
          timeoutDuration: JWKS_TIMEOUT_MS,
          cooldownDuration: JWKS_COOLDOWN_MS,
          cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
          [customFetch]: fetchImpl,
        });
        return keySet;
      })
      .finally(() => {
        pending = undefined;
      });

    return pending;
  };
}
