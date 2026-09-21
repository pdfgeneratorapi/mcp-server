/**
 * Hono middleware that challenges requests without a well-formed bearer token.
 * Verifying the token itself is a separate step.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthConfig } from './config.js';
import { challenges, type Challenge } from './challenges.js';

// RFC 6750 §2.1: the scheme is case-insensitive, the token is a b64token.
const BEARER_HEADER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export function respondWithChallenge(c: Context, challenge: Challenge): Response {
  return c.json(challenge.body, challenge.status, { 'WWW-Authenticate': challenge.wwwAuthenticate });
}

export function requireBearerToken(config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const authorization = c.req.header('Authorization');

    if (authorization === undefined) {
      return respondWithChallenge(c, challenges.missingCredentials(config.resourceMetadataUrl));
    }

    if (!BEARER_HEADER.test(authorization)) {
      return respondWithChallenge(c, challenges.invalidRequest(config.resourceMetadataUrl));
    }

    await next();
  };
}
