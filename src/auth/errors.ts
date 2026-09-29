/**
 * Errors raised while authenticating a request.
 */

/** The token cannot be accepted. The reason is for logs only, never for the client. */
export class InvalidTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid access token: ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/** The authorization server's metadata or keys could not be obtained, so no token can be checked. */
export class AuthorizationServerUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`Authorization server unavailable: ${reason}`, options);
    this.name = 'AuthorizationServerUnavailableError';
  }
}
