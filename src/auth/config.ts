/**
 * OAuth configuration for the HTTP transport, read once at startup.
 */

const DEFAULT_RESOURCE = 'https://mcp.pdfgeneratorapi.com/mcp';
const DEFAULT_ISSUER = 'https://auth.pdfgeneratorapi.com';
const DEFAULT_CREDENTIALS_URL = 'http://pdf-api-main/internal/mcp/credentials';
const WELL_KNOWN_PATH = '/.well-known/oauth-protected-resource';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface AuthConfig {
  /** Canonical URI of this MCP server, exactly as configured. Tokens must name it as their audience. */
  resource: string;
  /** Authorization server issuer, exactly as configured. */
  issuer: string;
  /** Path of the protected resource metadata document (RFC 9728 §3.1). */
  resourceMetadataPath: string;
  /** Absolute URL of the protected resource metadata document. */
  resourceMetadataUrl: string;
  /** Overrides discovery of the signing keys through the authorization server metadata. */
  jwksUri?: string;
  /** The api's in-cluster endpoint that mints API credentials for a verified grant. */
  credentialsUrl: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const resource = env.MCP_RESOURCE_URL ?? DEFAULT_RESOURCE;
  const issuer = env.OAUTH_ISSUER ?? DEFAULT_ISSUER;

  const jwksUri = env.OAUTH_JWKS_URI || undefined;
  const credentialsUrl = env.MCP_CREDENTIALS_URL || DEFAULT_CREDENTIALS_URL;

  const resourceUrl = parseServerUrl('MCP_RESOURCE_URL', resource);
  parseServerUrl('OAUTH_ISSUER', issuer);

  if (jwksUri !== undefined) {
    parseServerUrl('OAUTH_JWKS_URI', jwksUri);
  }

  parseInternalUrl('MCP_CREDENTIALS_URL', credentialsUrl);

  if (issuer.endsWith('/')) {
    throw new Error(`OAUTH_ISSUER must not end with a slash: "${issuer}"`);
  }

  const resourcePath = resourceUrl.pathname === '/' ? '' : resourceUrl.pathname;
  const resourceMetadataPath = `${WELL_KNOWN_PATH}${resourcePath}`;

  return {
    resource,
    issuer,
    resourceMetadataPath,
    resourceMetadataUrl: `${resourceUrl.origin}${resourceMetadataPath}`,
    jwksUri,
    credentialsUrl,
  };
}

/**
 * In-cluster endpoints are reached over plain http by service name, so only the shape
 * of the URL is checked.
 */
function parseInternalUrl(name: string, value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL: "${value}"`);
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error(`${name} must be an http(s) URL without credentials or fragment: "${value}"`);
  }

  return url;
}

function parseServerUrl(name: string, value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL: "${value}"`);
  }

  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));

  if (!secure || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '' || value.includes('?') || value.includes('#')) {
    throw new Error(`${name} must use https (or http on loopback) and carry no query, fragment or credentials: "${value}"`);
  }

  return url;
}
