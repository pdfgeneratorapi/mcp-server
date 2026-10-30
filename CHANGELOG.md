# Changelog

## Unreleased

### Added

- `list_fonts` lists the fonts the workspace's templates can use, so a client picks a `fontFamily` instead of guessing one; an unknown font is drawn with Open Sans. Each font has its `id`, its name, the styles it has glyphs of its own for, and the Unicode blocks it has at least half of, in percent. `covers` keeps only the fonts that can draw every character of a text, such as `₹` or `✓`. Needs the API release with `GET /fonts` (PGA-4180); before it, the tool answers 404.

### Fixed

- `update_template` no longer needs `name`. An update replaces only the top-level fields it sends, so `{"fontSubsetting": false}` changes that setting and keeps the stored name; the tool refused it before it reached the API. Needs the API release that accepts an update without a name (PGA-4225); before it, the API answers 422. `create_template` and `validate_template` still need a name.
- `create_template`, `update_template` and `validate_template` take every page format the API does: A2, A3, A4, A5, letter, label and custom, where they took only A4, letter and custom and refused an A3 template before it reached the API. Any other size is custom with `width` and `height`. A layout needs `format`, `orientation` and all four `margins`, as the API already required; the tools now say so, and refuse a layout without them instead of passing on the API's 422. Page margins take `top` and `left` too, `rotation` and `emptyLabels` are whole numbers, and `components` points to `get_template_schema` for each `cls`'s fields. Needs the API release where A2 and A3 have a size of their own (PGA-4204); before it, an A2 or A3 layout sent without `width` and `height` gets A4's size.

## 5.2.1 — 2026-10-28

### Fixed

- A tool call sends only the arguments the client gave. Validation filled in every schema default the client left out, so `update_template` without `fontSubsetting` or `barcodeAsImage` set a stored `true` back to `false`, and document tools sent the author `"Organization name"` in the metadata. The API applies its own defaults to what is missing. The tool schemas still show the defaults.

## 5.2.0 — 2026-10-27

### Changed

- `update_template` and the server instructions point to the template builder for changing a few components: `run_builder_tool` with `patch_component`, `add_component` or `remove_component` changes one component without resending the template. `update_template`'s description no longer says the whole template is replaced; each top-level field sent replaces the stored one. Needs the API release that gives every component an id (PGA-4200); before it, a component saved without an id cannot be addressed. A template saved before that release gets its ids the next time it is saved.

## 5.1.0 — 2026-10-27

### Changed

- `create_template`, `update_template`, `copy_template` and `import_template` answer with a summary of the saved template: its id, name, tags and draft state, how many pages and components it has, and anything else the API reports next to the template, such as warnings. The whole template could run to hundreds of thousands of characters, over a chat client's tool-output limit. Set `full_response` to `true` to get it, or read it with `get_template`.

## 5.0.1 — 2026-10-23

### Fixed

- The template builder tools answered 404 on the hosted server: their address was derived from `API_BASE_URL`, whose host does not route the builder path. `BUILDER_BASE_URL` now defaults to the in-cluster service, `http://pdf-api-main/api/mcp/builder`; stdio development outside the cluster sets it explicitly.

## 5.0.0 — 2026-10-22

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
