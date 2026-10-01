/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728), which tells MCP clients where to
 * get a token for this server.
 */
import {
  OAuthProtectedResourceMetadataSchema,
  type OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthConfig } from './config.js';
import { SUPPORTED_SCOPES } from './scopes.js';

const RESOURCE_NAME = 'PDF Generator API';

/**
 * Parsed against the SDK schema so a malformed document stops the server at startup
 * instead of failing discovery in clients. MCP clients request the scopes listed in
 * scopes_supported; an empty list is worse than none for strict clients.
 */
export function buildProtectedResourceMetadata(config: AuthConfig): OAuthProtectedResourceMetadata {
  return OAuthProtectedResourceMetadataSchema.parse({
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    resource_name: RESOURCE_NAME,
    ...(SUPPORTED_SCOPES.length > 0 ? { scopes_supported: SUPPORTED_SCOPES } : {}),
  });
}
