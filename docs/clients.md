# MCP client compatibility

How each MCP client behaved against the server, tested end to end on the staging deployment: sign-in, discovery, registration, tool calls and token refresh. This file is the record of client behaviour; update it when a client is retested.

Run `npm run smoke` (see [the smoke test](#smoke-test)) to check a deployment's side of the flow without a client.

## Results

Last tested 2026-10-21. Observations made after that are dated where they appear below.

| Client (version) | Registration | Sends `resource` | Protocol | Tool calls | Silent refresh |
|---|---|---|---|---|---|
| Claude Code | Client ID Metadata Document (`claude.ai`) | yes | 2025-11-25, session | yes | yes |
| claude.ai, Claude Desktop | Client ID Metadata Document (`claude.ai`) | yes, also on refresh | 2026-07-28 | yes, including the template builder | yes |
| ChatGPT (web) | Dynamic Client Registration, or its Client ID Metadata Document | yes | 2025-era, session | yes | yes |
| ChatGPT (desktop), Codex | Client ID Metadata Document (`chatgpt.com`) | yes | connection check on 2025-06-18 with a session; tool calls on 2026-07-28 | yes | yes; revokes its token on uninstall |
| MCP Inspector 2.9.0 | Dynamic Client Registration | yes | 2026-07-28 with Protocol Era set to Auto | yes | yes |
| Cursor 3.25.9 | Dynamic Client Registration | yes | 2025-11-25, session | yes, including the template builder | yes |
| VS Code 1.142.0 (Copilot Chat) | Client ID Metadata Document (`vscode.dev`) | yes | 2025-11-25, session | yes | yes; also opens a new session when its session expired |

Every client:

- followed the `401` challenge to the protected resource metadata and the authorization server metadata;
- used PKCE with `S256`;
- sent the RFC 8707 `resource` parameter on both the authorization and the token request.

The authorization server refuses a request without a known `resource`.

### Scope step-up

When a tool call needs a permission the connection lacks, the server answers `403 insufficient_scope` with a `scope` that lists what the connection already has plus the missing permission.

- **VS Code** re-authorizes on its own: it opens the consent page asking for exactly the scopes in the challenge, so the connection keeps the permissions it had, and retries the call after you allow it.
- **claude.ai** (2026-11-18) shows **Allow additional access to continue** with **Reconnect**. Reconnecting asks for every scope the server supports, not only those in the challenge, so the consent page opens with every permission selected and you choose them again.

Not yet recorded for the other clients.

### Tool approvals

`read_operation` is hinted read-only, `call_operation` as a change that destroys nothing, and `delete_operation` as destructive. Whether a client asks before running one is up to the client.

- **ChatGPT**, tested through Codex (2026-11-19): asks before every `call_operation` and `delete_operation`, showing the operation's ID and arguments, with **Allow once**, **Always allow** and **Deny**. It runs `read_operation` without asking.
- **claude.ai** (2026-11-18), with **Auto** selected in the chat, ran `delete_operation` without asking.

### Ended connections

When a connection was revoked (for example in **Settings → Connected applications**), has expired, or is no longer known, the next tool call is answered with `401 invalid_token`, so the client signs in again instead of reporting an error.

The server keeps the API credential of a connection for a few minutes. If it still holds one from before the connection ended, that tool call fails with an error saying the connection has ended and asking to send the request again; the request after it is answered with `401 invalid_token`.

## Client notes

**MCP Inspector**: each server's **Settings → Protocol Era** defaults to **Legacy (2025-11-25 handshake)**, so Inspector reports the legacy era even though the server supports 2026-07-28. Set it to **Auto** or **Modern**. If Inspector reuses a client registration the authorization server no longer knows, the sign-in page answers `invalid_client`: use **Clear stored OAuth state** in the same settings and connect again.

**VS Code**: the server is configured in VS Code's own `mcp.json` under `"servers"` (**MCP: Add Server**, or **MCP: Open User Configuration**), not in `~/.copilot/mcp-config.json`, which belongs to the Copilot CLI. Its tools are used from Copilot Chat in **Agent** mode, which needs a signed-in GitHub Copilot account; start the server from `mcp.json` or **MCP: List Servers** to sign in. If a sign-in is left unfinished (the consent page denied, or its prompt closed), VS Code stops asking for that server: run **Developer: Reload Window** and start the server again.

**ChatGPT**: a chat started before the connector was added or reinstalled cannot use it; attach the connector to the chat or start a new one.

ChatGPT keeps the tool list it fetched earlier, and Codex uses the same list for the app (2026-11-19). When the server's tools change, as they did in 6.0.0, the model keeps calling the old tools and every call is refused, until the app's tools are refreshed in ChatGPT's app settings, or the app is removed and added again. The refusal asks the model to tell the user so.

Codex runs several tool calls at once (2026-11-19). Some are then refused by the API, with `429` (it takes 2 requests a second) or `409` (a template takes one builder step at a time), and Codex runs them again.

**Any client**: if a client keeps a refresh token whose connection has ended, its refresh fails and some clients report a generic error instead of signing in again. Remove the server from the client and add it again.

## Smoke test

`scripts/smoke.mjs` walks the flow a client follows and checks each step against a deployment:

1. An unauthenticated request gets `401` with a `WWW-Authenticate` challenge naming the protected resource metadata.
2. The protected resource metadata names this server as the resource and an authorization server.
3. The authorization server metadata names that issuer and supports `S256`, registration, revocation and Client ID Metadata Documents.
4. It signs in: it registers a client, prints the authorization URL to open in a browser, receives the code on a loopback address, checks the `iss` parameter and exchanges the code for a token with `resource`. Pass an access token in `MCP_ACCESS_TOKEN` to skip this step.
5. A 2025-era client opens a session, lists the tools and runs `get_status` with `read_operation`.
6. A 2026-07-28 client discovers the server, lists the tools and runs `get_status` with `read_operation`.
7. The access token is refused by the API itself, so the tool calls must have reached the API with a credential the server obtained for the grant.
8. It revokes the token it obtained.

```bash
npm run smoke                                                 # staging
MCP_URL=https://mcp.pdfgeneratorapi.com/mcp npm run smoke     # production
MCP_ACCESS_TOKEN=… npm run smoke                              # with a token you already have
```

`API_BASE_URL` sets the API checked in step 7 (default: the staging API for the staging server, otherwise `https://us1.pdfgeneratorapi.com/api/v4`).
