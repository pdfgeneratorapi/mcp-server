/**
 * Hono middleware that authenticates every request to the MCP endpoint.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { log } from '../logger.js';
import type { AuthConfig } from './config.js';
import { challenges, type Challenge } from './challenges.js';
import { AuthorizationServerUnavailableError, InvalidTokenError } from './errors.js';
import type { TokenVerifier } from './verifier.js';

export type AuthVariables = { authInfo: AuthInfo };

// RFC 6750 §2.1: the scheme is case-insensitive, the token is a b64token.
const BEARER_HEADER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
const RETRY_AFTER_SECONDS = '30';

export function respondWithChallenge(c: Context, challenge: Challenge): Response {
  return c.json(challenge.body, challenge.status, { 'WWW-Authenticate': challenge.wwwAuthenticate });
}

export function requireBearerToken(config: AuthConfig, verifier: TokenVerifier): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const authorization = c.req.header('Authorization');

    if (authorization === undefined) {
      return respondWithChallenge(c, challenges.missingCredentials(config.resourceMetadataUrl));
    }

    const match = BEARER_HEADER.exec(authorization);

    if (!match) {
      return respondWithChallenge(c, challenges.invalidRequest(config.resourceMetadataUrl));
    }

    try {
      c.set('authInfo', await verifier.verify(match[1]));
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return respondWithChallenge(c, challenges.invalidToken(config.resourceMetadataUrl));
      }

      if (error instanceof AuthorizationServerUnavailableError) {
        log.error(error.message);
        return c.json(
          { error: 'temporarily_unavailable', error_description: 'The authorization server cannot be reached' },
          503,
          { 'Retry-After': RETRY_AFTER_SECONDS },
        );
      }

      throw error;
    }

    await next();
  };
}
