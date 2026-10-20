# Migrating from 4.x to 5.0

Version 5 replaces the JWT you created and pasted into your MCP client with a sign-in. The hosted server at `https://mcp.pdfgeneratorapi.com/mcp` moves to version 5, and tokens you created yourself stop working there.

## If you use the hosted server

1. Remove the PDF Generator API server from your MCP client's configuration, together with its token: the `BEARER_TOKEN_JWT` variable, or the `Authorization: Bearer …` header.
2. Add it again by URL, `https://mcp.pdfgeneratorapi.com/mcp`, as described in the [README](../README.md#connect).
3. Connect. Your client opens the PDF Generator API sign-in page: sign in, choose the workspace, the permissions and how long the connection lasts.

You can then delete the JWT you created for the MCP server. If nothing else uses it, consider rotating the workspace's secret key in the dashboard.

Tool names are unchanged, so prompts and instructions that name tools keep working. A connection with limited permissions sees fewer tools.

### Where the settings went

| 4.x | 5.0 |
|-----|-----|
| JWT in `BEARER_TOKEN_JWT` or an `Authorization` header | Sign-in when the client connects |
| Workspace named in the JWT (`iss`/`sub`) | Workspace chosen at sign-in |
| Token lifetime (`expiresIn`) | Connection length chosen at sign-in (1–90 days); access tokens refresh on their own |
| Every tool, always | Tools follow the permissions granted at sign-in |
| Deleting the token to cut access | **Settings → Connected applications** in the dashboard |

### Claude Desktop and `mcp-remote`

The 4.x README connected Claude Desktop through `mcp-remote` with a token header. Claude Desktop now adds the server directly under **Settings → Connectors**. If you keep `mcp-remote` for a client that only starts local servers, drop the `--header` argument: `mcp-remote` handles the sign-in itself.

## If you run your own server

Version 5 runs only as part of the PDF Generator API deployment: it needs the PDF Generator API authorization server and its internal credential endpoint. To run your own server against your own API base URL, stay on 4.x, the [`main`](https://github.com/pdfgeneratorapi/mcp-server/tree/main) branch.

## If you use the code as a library

`createMcpServer` and `executeApiTool` take a credentials object instead of a bearer token string:

```ts
// 4.x
createMcpServer(bearerToken);
executeApiTool(name, definition, args, bearerToken);

// 5.0
createMcpServer(createStaticCredentials(token));
executeApiTool(name, definition, args, { getToken: async () => token, invalidate: () => {} });
```

## For local development

stdio mode reads `MCP_DEV_API_TOKEN` instead of `BEARER_TOKEN_JWT`. It is meant for developing the server, not for connecting an assistant to your account.
