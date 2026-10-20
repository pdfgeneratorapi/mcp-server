# MCP client compatibility

How each MCP client behaved against the server, tested end to end on the staging deployment: sign-in, discovery, registration, tool calls and token refresh. This file is the record of client behaviour; update it when a client is retested.

Run `npm run smoke` (see [the smoke test](#smoke-test)) to check a deployment's side of the flow without a client.

## Results

Last tested 2026-10-20.

| Client (version) | Registration | Sends `resource` | Protocol | Tool calls | Silent refresh |
|---|---|---|---|---|---|
| Claude Code | Client ID Metadata Document (`claude.ai`) | yes | 2025-11-25, session | yes | yes |
| claude.ai, Claude Desktop | Client ID Metadata Document (`claude.ai`) | yes, also on refresh | 2026-07-28 | yes, including the template builder | yes |
| ChatGPT (web) | Dynamic Client Registration, or its Client ID Metadata Document | yes | 2025-era, session | yes | yes |
| ChatGPT (desktop), Codex | Client ID Metadata Document (`chatgpt.com`) | yes | connection check on 2025-06-18 with a session; tool calls on 2026-07-28 | yes | yes; revokes its token on uninstall |
| MCP Inspector 2.9.0 | Dynamic Client Registration | yes | 2026-07-28 with Protocol Era set to Auto | yes | yes |
| Cursor 3.25.9 | Dynamic Client Registration | yes | 2025-11-25, session | yes, including the template builder | not yet observed |
| VS Code 1.142.0 (Copilot Chat) | Client ID Metadata Document (`vscode.dev`) | yes | 2025-11-25, session | yes | not yet observed |

Every client:

- followed the `401` challenge to the protected resource metadata and the authorization server metadata;
- used PKCE with `S256`;
- sent the RFC 8707 `resource` parameter on both the authorization and the token request.

The authorization server refuses a request without a known `resource`.

Not yet recorded per client: how a client reacts to a `403 insufficient_scope` step-up challenge.

## Client notes

**MCP Inspector**: each server's **Settings → Protocol Era** defaults to **Legacy (2025-11-25 handshake)**, so Inspector reports the legacy era even though the server supports 2026-07-28. Set it to **Auto** or **Modern**. If Inspector reuses a client registration the authorization server no longer knows, the sign-in page answers `invalid_client`: use **Clear stored OAuth state** in the same settings and connect again.

**VS Code**: the server is configured in VS Code's own `mcp.json` under `"servers"` (**MCP: Add Server**, or **MCP: Open User Configuration**), not in `~/.copilot/mcp-config.json`, which belongs to the Copilot CLI. Its tools are used from Copilot Chat in **Agent** mode, which needs a signed-in GitHub Copilot account; start the server from `mcp.json` or **MCP: List Servers** to sign in.

**ChatGPT**: a chat started before the connector was added or reinstalled cannot use it; attach the connector to the chat or start a new one.

**Any client**: if a client keeps a refresh token whose connection has ended (expired, revoked, or removed on the server side), it may keep retrying and report a generic error. Remove the server from the client and add it again.

## Smoke test

`scripts/smoke.mjs` walks the flow a client follows and checks each step against a deployment:

1. An unauthenticated request gets `401` with a `WWW-Authenticate` challenge naming the protected resource metadata.
2. The protected resource metadata names this server as the resource and an authorization server.
3. The authorization server metadata names that issuer and supports `S256`, registration, revocation and Client ID Metadata Documents.
4. It signs in: it registers a client, prints the authorization URL to open in a browser, receives the code on a loopback address, checks the `iss` parameter and exchanges the code for a token with `resource`. Pass an access token in `MCP_ACCESS_TOKEN` to skip this step.
5. A 2025-era client opens a session, lists the tools and calls `get_status`.
6. A 2026-07-28 client discovers the server, lists the tools and calls `get_status`.
7. The access token is refused by the API itself, so the tool calls must have reached the API with a credential the server obtained for the grant.
8. It revokes the token it obtained.

```bash
npm run smoke                                                 # staging
MCP_URL=https://mcp.pdfgeneratorapi.com/mcp npm run smoke     # production
MCP_ACCESS_TOKEN=… npm run smoke                              # with a token you already have
```

`API_BASE_URL` sets the API checked in step 7 (default: the staging API for the staging server, otherwise `https://us1.pdfgeneratorapi.com/api/v4`).
