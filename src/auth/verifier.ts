/**
 * Verifies access tokens issued by the authorization server for this MCP server.
 */
import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { log } from '../logger.js';
import { AuthorizationServerUnavailableError, InvalidTokenError } from './errors.js';

export const WORKSPACE_CLAIM = 'https://pdfgeneratorapi.com/claims/workspace_id';

const ALGORITHM = 'RS256';

export interface TokenVerifier {
  verify(token: string): Promise<AuthInfo>;
}

export interface TokenVerifierOptions {
  issuer: string;
  /** The canonical resource URI; the token's aud must be exactly this string. */
  audience: string;
  keySet: () => Promise<JWTVerifyGetKey>;
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  return {
    async verify(token: string): Promise<AuthInfo> {
      const { header, claims } = decode(token);

      // Cheap checks first: a forged token for another issuer or algorithm never
      // reaches the key set, which can mean a network fetch.
      if (header.alg !== ALGORITHM) {
        throw rejected('algorithm not allowed', header.kid, claims);
      }

      if (claims.iss !== options.issuer) {
        throw rejected('issuer mismatch', header.kid, claims);
      }

      const keySet = await options.keySet();
      let payload: JWTPayload;

      try {
        ({ payload } = await jwtVerify(token, keySet, {
          algorithms: [ALGORITHM],
          issuer: options.issuer,
          audience: options.audience,
          requiredClaims: ['exp', 'sub'],
        }));
      } catch (error) {
        if (isKeySetUnavailable(error)) {
          throw new AuthorizationServerUnavailableError('cannot fetch the signing keys', { cause: error });
        }

        throw rejected(error instanceof errors.JOSEError ? error.code : 'verification failed', header.kid, claims);
      }

      if (payload.aud !== options.audience) {
        throw rejected('audience is not exactly this resource', header.kid, payload);
      }

      const clientId = payload.client_id;
      const workspaceId = payload[WORKSPACE_CLAIM];

      if (typeof clientId !== 'string' || clientId === '') {
        throw rejected('no client_id', header.kid, payload);
      }

      if (typeof workspaceId !== 'number' || !Number.isInteger(workspaceId) || workspaceId <= 0) {
        throw rejected('no workspace claim', header.kid, payload);
      }

      return {
        token,
        clientId,
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: new URL(options.audience),
        extra: { sub: payload.sub, workspaceId, jti: payload.jti },
      };
    },
  };
}

function decode(token: string) {
  try {
    return { header: decodeProtectedHeader(token), claims: decodeJwt(token) };
  } catch {
    throw new InvalidTokenError('not a JWT');
  }
}

function scopesOf(payload: JWTPayload): string[] {
  const scopes = payload.scopes;

  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [];
}

/**
 * A timeout, a malformed key set or a failed fetch means the keys could not be read,
 * which says nothing about the token.
 */
function isKeySetUnavailable(error: unknown): boolean {
  return error instanceof errors.JWKSTimeout
    || error instanceof errors.JWKSInvalid
    || !(error instanceof errors.JOSEError)
    || error.code === 'ERR_JOSE_GENERIC';
}

function rejected(reason: string, kid: string | undefined, claims: JWTPayload): InvalidTokenError {
  log.debug('Access token rejected', { reason, jti: claims.jti, kid, sub: claims.sub });

  return new InvalidTokenError(reason);
}
