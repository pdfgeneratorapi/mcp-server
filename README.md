# PDF Generator API — MCP Server

Model Context Protocol (MCP) server for the [PDF Generator API](https://pdfgeneratorapi.com). It lets AI assistants generate PDFs from your templates, build and edit templates, manage workspaces, convert HTML and URLs to PDF, create e-invoices and run PDF tools such as watermarking, encryption and form filling.

The server is hosted. Add its URL to your MCP client and sign in with your PDF Generator API account; there is nothing to install and no token to create.

```
https://mcp.pdfgeneratorapi.com/mcp
```

## Connect

### Claude (claude.ai and Claude Desktop)

Open **Settings → Connectors**, choose **Add custom connector**, paste the URL and connect. Claude opens the PDF Generator API sign-in page.

### Claude Code

```bash
claude mcp add --transport http pdf-generator-api https://mcp.pdfgeneratorapi.com/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**.

### ChatGPT

Add a custom MCP connector with the URL. ChatGPT opens the PDF Generator API sign-in page when you connect.

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "pdf-generator-api": {
      "url": "https://mcp.pdfgeneratorapi.com/mcp"
    }
  }
}
```

### VS Code

Run **MCP: Add Server** from the Command Palette and choose HTTP, or add the server to `mcp.json` (**MCP: Open User Configuration** for every workspace, `.vscode/mcp.json` for one):

```json
{
  "servers": {
    "pdf-generator-api": {
      "type": "http",
      "url": "https://mcp.pdfgeneratorapi.com/mcp"
    }
  }
}
```

Start the server from `mcp.json` or **MCP: List Servers** to sign in. Its tools are used from Copilot Chat in **Agent** mode, with a signed-in GitHub Copilot account.

### Clients that only start local servers

A client that can only run local (stdio) servers connects through the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge, which handles the sign-in:

```json
{
  "mcpServers": {
    "pdf-generator-api": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.pdfgeneratorapi.com/mcp"]
    }
  }
}
```

How each client was tested, and what to do when one misbehaves: [client compatibility](docs/clients.md).

## Signing in and permissions

When a client connects, you sign in to PDF Generator API and choose:

- **The workspace** the connection works in.
- **What it may do**, per module: templates, documents, forms and workspaces can each be None, Read only or Full; e-invoices and PDF tools are allowed or not. Full includes deleting, which the consent screen marks as permanent.
- **How long it lasts**: 1, 7, 30 or 90 days. A connection unused for 30 days also ends.

The client only sees the tools your choices allow. If it calls a tool outside them, it is asked to reconnect with the missing permission.

You get an email the first time an application connects to a workspace. To see or end connections, open **Settings → Connected applications** in the PDF Generator API dashboard. Clients that support it also end their connection when you remove the server.

## What it can do

- **Templates**: list, read, create, update, copy, import from PDF, validate, manage versions, browse the template library, list the fonts templates can use and open the template editor.
- **Template builder**: `get_builder_guide`, `list_builder_tools` and `run_builder_tool` give the assistant the granular steps the PDF Generator API editor uses to build a template (add, change, move and remove components, pages and table rows; validate). The assistant does the work with its own model, so building a template this way spends none of your workspace's AI credits.
- **Documents**: generate PDFs (one or in batches, synchronously or asynchronously), and list, read and delete generated documents.
- **Forms**: create, import, update, share and delete forms.
- **Conversion and PDF tools**: HTML and URL to PDF, PDF to image, watermark, encrypt, decrypt, optimize, add accessibility tags, extract and fill PDF form fields, QR codes.
- **E-invoices**: UBL, CII, XRechnung and Factur-X.
- **Workspaces**: list, create and delete.

It also offers three prompts: `generate-pdf`, `convert-to-pdf` and `create-einvoice`.

The server speaks MCP protocol revision 2026-07-28, which needs no session, and still serves clients that open with the 2025-era `initialize` handshake.

## Upgrading from 4.x

Version 5 connects with OAuth only: a JWT you created yourself and passed as `BEARER_TOKEN_JWT` or in an `Authorization` header is no longer accepted. See [the migration guide](docs/migrating-from-4.x.md) and the [changelog](CHANGELOG.md).

To run your own server against your own API base URL, use the 4.x line on the [`main`](https://github.com/pdfgeneratorapi/mcp-server/tree/main) branch.

## Development

Requires Node.js 24 or later.

```bash
npm install
npm run build
npm test
```

### stdio (local development)

stdio mode has no sign-in. For local development it can call the API with a fixed token you create from your workspace's API credentials ([creating a JWT](https://docs.pdfgeneratorapi.com/v4#section/Authentication/Creating-a-JWT)):

```bash
MCP_DEV_API_TOKEN="your-v4-jwt" npm run start:stdio
```

It is not a way to connect an assistant to your account; use the hosted URL for that.

### HTTP

```bash
cp .env.example .env
npm run start:http
# MCP endpoint: http://localhost:3000/mcp
# Health check: http://localhost:3000/health
```

or with Docker:

```bash
docker compose -f deploy/docker-compose.yml up -d
# MCP endpoint: http://localhost:3001/mcp
```

HTTP mode accepts only access tokens issued by the authorization server in `OAUTH_ISSUER` for the resource in `MCP_RESOURCE_URL`, and gets its API credentials from the PDF Generator API's internal credential endpoint, so it runs as part of the PDF Generator API deployment.

### Configuration

| Variable | Mode | Default | Description |
|----------|------|---------|-------------|
| `API_BASE_URL` | Both | `https://us1.pdfgeneratorapi.com/api/v4` | PDF Generator API base URL |
| `BUILDER_BASE_URL` | Both | `http://pdf-api-main/api/mcp/builder` | In-cluster template builder endpoints; set it for stdio development outside the cluster |
| `MCP_DEV_API_TOKEN` | stdio | — | Fixed API token, for local development only |
| `LOG_LEVEL` | Both | `info` | `debug` adds per-request detail |
| `PORT` | HTTP | `3000` | Server port |
| `MCP_RESOURCE_URL` | HTTP | `https://mcp.pdfgeneratorapi.com/mcp` | Canonical URL of this server; access tokens must name it as their audience |
| `OAUTH_ISSUER` | HTTP | `https://auth.pdfgeneratorapi.com` | Authorization server that issues the access tokens (no trailing slash) |
| `OAUTH_JWKS_URI` | HTTP | from the issuer's metadata | Signing keys of the authorization server |
| `MCP_CREDENTIALS_URL` | HTTP | `http://pdf-api-main/internal/mcp/credentials` | Internal endpoint that issues API credentials for a verified access token |
| `MCP_SCOPE_ENFORCEMENT` | HTTP | `warn` | `off`, `warn` (log only) or `enforce` |
| `MCP_REQUESTS_PER_MINUTE` | HTTP | `600` | Requests one user's client may make per minute, per process; `0` turns it off |
| `MCP_INITIALIZE_PER_MINUTE` | HTTP | `30` | 2025-era sessions one user's client may open per minute, per process; `0` turns it off |
| `SESSION_TTL_MINUTES` | HTTP | `30` | Idle timeout of a 2025-era session |
| `MCP_MAX_SESSIONS` | HTTP | `1000` | Open 2025-era sessions per process |
| `MCP_MAX_BODY_BYTES` | HTTP | `1048576` | Largest request body |
| `MCP_ALLOWED_HOSTS` | HTTP | — | Extra hosts this server answers for, besides the one in `MCP_RESOURCE_URL` |
| `CORS_ORIGIN` | HTTP | `*` | Comma-separated allowed origins |

### Regenerating the tools

The API tools are generated from the OpenAPI v4 specification in `docs/apiv4.json`:

```bash
./scripts/generate-mcp.sh
# or with another spec:
./scripts/generate-mcp.sh --input /path/to/apiv4.json
```

Custom patches may need to be re-applied after regeneration.

## Resources

- [MCP documentation](https://modelcontextprotocol.io)
- [PDF Generator API documentation](https://docs.pdfgeneratorapi.com/v4)
