# Changelog

## 5.0.0 — unreleased

Version 5 is the hosted PDF Generator API MCP server at `https://mcp.pdfgeneratorapi.com/mcp`. Clients connect with OAuth: the user signs in, chooses a workspace and grants permissions, with no token to create. It is not published as a package; see [the migration guide](docs/migrating-from-4.x.md).

### Breaking

- OAuth only. The server accepts access tokens issued by the PDF Generator API authorization server for this server, and nothing else: a JWT you created yourself, sent in the `Authorization` header, is refused with a `401` that tells the client where to sign in.
- `BEARER_TOKEN_JWT` is gone. stdio mode is for local development and reads `MCP_DEV_API_TOKEN`.
- The server no longer forwards the client's token to the API. It calls the API with short-lived credentials issued for the connection's grant.
- `createMcpServer(credentials?, onToolCall?)` and `executeApiTool(toolName, definition, args, upstreamAuth?, onUpstreamStatus?)` take credentials instead of a bearer token string.

### Added

- OAuth protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`, and `WWW-Authenticate` challenges that point clients to it.
- Permissions per connection: the tools a client sees follow the permissions the user granted, and a call outside them is answered with an `insufficient_scope` step-up challenge (`MCP_SCOPE_ENFORCEMENT`). The challenge names the permissions the connection already has plus the missing one, so signing in again keeps them all.
- Ended connections: when a connection was revoked or has expired, the next tool call is answered with a `401` challenge, so the client signs in again instead of reporting an error. A call already under way when the connection ended returns an error asking to send the request again.
- MCP protocol revision 2026-07-28, served without sessions, next to 2025-era clients, which keep their sessions. stdio serves both.
- Template builder tools: `get_builder_guide`, `list_builder_tools` and `run_builder_tool` let a client build and edit templates step by step with its own model, without spending the workspace's AI credits.
- Tools from the current API spec: `convert_pdf_to_image`, `store_document`, `generate_viewer_url`, `get_document_actions`, `get_document_signatures`, `get_document_versions`, `open_form_builder`, `open_form_builder_for_existing_form`, `get_template_library` and `get_template_library_item`.
- Form tools set every action: store, download, sign and send.
- The PDF Generator API icon in the server information.
- Rate limits per user (`MCP_REQUESTS_PER_MINUTE`, `MCP_INITIALIZE_PER_MINUTE`).
- `server.json`, which describes the hosted server for the official MCP Registry.

### Changed

- 2025-era sessions are bound to the user, client and organization that opened them.
- The per-request log line names the OAuth client, user, workspace and organization, and the builder tool a `run_builder_tool` call ran. It still never logs tokens or tool arguments.
- Tool fields that may be null use a single type, which more clients accept.
- The tool catalogue follows the current API spec.

### Fixed

- Binary API responses (PDFs, images) are returned intact instead of as mangled text.
- Arguments of tools whose request body is one of several shapes (`generate_document`, `open_editor`, the PDF tools and others) are validated again before the API is called.
- Form actions kept only the store action; they now keep every action and its description.

### Removed

- `smithery.yaml`. Smithery lists the hosted server from its URL.
- The JWT creation instructions from the README.

## 4.0.17

The last version that accepts a JWT you create yourself. It stays on the [`main`](https://github.com/pdfgeneratorapi/mcp-server/tree/main) branch for running your own server.
