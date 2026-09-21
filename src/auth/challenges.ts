/**
 * Bearer token challenges (RFC 6750 §3, RFC 9728 §5.1). The header strings are a wire
 * contract; change them only together with their tests.
 */

export interface ChallengeBody {
  error?: string;
  error_description: string;
}

export interface Challenge {
  status: 401 | 403;
  wwwAuthenticate: string;
  body: ChallengeBody;
}

const INVALID_REQUEST_DESCRIPTION = 'The Authorization header must be a Bearer token';
const INVALID_TOKEN_DESCRIPTION = 'The access token is not valid';
const INSUFFICIENT_SCOPE_DESCRIPTION = 'The access token does not grant the required scope';
const MISSING_CREDENTIALS_DESCRIPTION = 'This resource requires an access token';

function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}

function bearer(parameters: Array<[string, string]>): string {
  return `Bearer ${parameters.map(([name, value]) => `${name}=${quote(value)}`).join(', ')}`;
}

export const challenges = {
  /** No credentials at all: no error code, only where to find the authorization server. */
  missingCredentials(resourceMetadataUrl: string): Challenge {
    return {
      status: 401,
      wwwAuthenticate: bearer([['resource_metadata', resourceMetadataUrl]]),
      body: { error_description: MISSING_CREDENTIALS_DESCRIPTION },
    };
  },

  invalidRequest(resourceMetadataUrl: string): Challenge {
    return {
      status: 401,
      wwwAuthenticate: bearer([
        ['error', 'invalid_request'],
        ['error_description', INVALID_REQUEST_DESCRIPTION],
        ['resource_metadata', resourceMetadataUrl],
      ]),
      body: { error: 'invalid_request', error_description: INVALID_REQUEST_DESCRIPTION },
    };
  },

  /** Deliberately the same for a bad signature, an expired token and a wrong audience. */
  invalidToken(resourceMetadataUrl: string): Challenge {
    return {
      status: 401,
      wwwAuthenticate: bearer([
        ['error', 'invalid_token'],
        ['error_description', INVALID_TOKEN_DESCRIPTION],
        ['resource_metadata', resourceMetadataUrl],
      ]),
      body: { error: 'invalid_token', error_description: INVALID_TOKEN_DESCRIPTION },
    };
  },

  insufficientScope(resourceMetadataUrl: string, requiredScopes: string[]): Challenge {
    return {
      status: 403,
      wwwAuthenticate: bearer([
        ['error', 'insufficient_scope'],
        ['scope', requiredScopes.join(' ')],
        ['error_description', INSUFFICIENT_SCOPE_DESCRIPTION],
        ['resource_metadata', resourceMetadataUrl],
      ]),
      body: { error: 'insufficient_scope', error_description: INSUFFICIENT_SCOPE_DESCRIPTION },
    };
  },
};
