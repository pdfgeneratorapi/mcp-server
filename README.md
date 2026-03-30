# PDF Generator API — MCP Server

Model Context Protocol (MCP) server for the [PDF Generator API](https://pdfgeneratorapi.com), generated from the OpenAPI v4 specification.

## Overview

This server supports **both** stdio and HTTP transports:
- **Stdio mode** (default): For local MCP client integration (Claude Desktop, Claude Code, Cline, etc.)
- **HTTP mode**: For production deployment, marketplaces, and multiple clients

## Quick Start

### Local Development (Stdio Mode)

**Install and build**:
```bash
npm install
npm run build
```

**MCP Client Configuration Example**:
```json
{
  "mcpServers": {
    "pdf-generator-api": {
      "command": "node",
      "args": ["/path/to/mcp-server/build/index.js"],
      "env": {
        "API_BASE_URL": "https://us1.pdfgeneratorapi.com/api/v4",
        "BEARER_TOKEN_JWT": "your-jwt-token-here"
      }
    }
  }
}
```

**Note**: Replace `/path/to/mcp-server` with your actual path and `your-jwt-token-here` with your PDF Generator API JWT token (see [JWT Token Generation](#jwt-token-generation) below).

**Common config locations**:
- **Claude Desktop**: Settings > Developer > Edit Config
- **Claude Code (CLI)**: `~/.claude/mcp_config.json`
- **Cline/Roo-Codeium**: `.vscode/mcp_config.json`
- **Continue**: `~/.continue/config.json`

### Remote MCP Server (Streamable HTTP)

If you have a deployed MCP server (e.g. `https://mcp.example.com`), you can connect to it directly from your MCP client without running anything locally.

**Claude Code** (`~/.claude/mcp_config.json`):
```json
{
  "mcpServers": {
    "pdf-generator-api": {
      "type": "streamable-http",
      "url": "https://mcp.pdfgeneratorapi.com/mcp",
      "headers": {
        "Authorization": "Bearer your-jwt-token-here"
      }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):

Claude Desktop does not support `streamable-http` directly. Use [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) as a bridge:
```json
{
  "mcpServers": {
    "pdf-generator-api": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.pdfgeneratorapi.com/mcp",
        "--header",
        "Authorization: Bearer your-jwt-token-here"
      ]
    }
  }
}
```

**Note**: For remote servers, use a long-lived JWT token (e.g. `--expiresIn 30d`) to avoid mid-session expiration. See [JWT Token Generation](#jwt-token-generation) for how to create one. Restart your MCP client after updating the config.

### Production Deployment (HTTP Mode)

**Run locally**:
```bash
npm install
npm run start:http
# Server runs on http://localhost:3000
# MCP endpoint: http://localhost:3000/mcp
# Health check: http://localhost:3000/health
```

**Docker**:
```bash
docker compose -f deploy/docker-compose.yml up -d
# MCP endpoint: http://localhost:3001/mcp
```

## Authentication

**Stdio Mode**: Pass the JWT token via the `BEARER_TOKEN_JWT` environment variable in your MCP client config.

**HTTP Mode**: Pass the JWT token in the `Authorization` header with each request:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your-jwt-token-here" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
```

## JWT Token Generation

You need a JWT token to authenticate with the PDF Generator API. Get your credentials from the [PDF Generator API dashboard](https://app.pdfgeneratorapi.com) under **Account Settings > API Integration**.

You'll need three values:
- **Workspace ID** (`iss` claim) — your numeric workspace identifier
- **Workspace Identifier** (`sub` claim) — your workspace email or unique key
- **Secret Key** — the signing key for your JWT (keep this secret)

See: https://docs.pdfgeneratorapi.com/v4#section/Authentication/Creating-a-JWT

### Node.js

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  {
    iss: 'YOUR_WORKSPACE_ID',       // e.g. "12345"
    sub: 'YOUR_WORKSPACE_IDENTIFIER' // e.g. "user@example.com"
  },
  'YOUR_SECRET_KEY',
  {
    algorithm: 'HS256',
    expiresIn: '24h'  // Token lifetime — see notes below
  }
);

console.log(token);
```

### Quick one-liner (npx)

```bash
npx jsonwebtoken-cli -- sign \
  '{"iss":"YOUR_WORKSPACE_ID","sub":"YOUR_WORKSPACE_IDENTIFIER"}' \
  'YOUR_SECRET_KEY' \
  --algorithm HS256 \
  --expiresIn 24h
```

### Token Expiration (TTL)

Choose a TTL that matches your use case:

| Use case | Recommended TTL | Why |
|----------|----------------|-----|
| Local MCP (stdio) | `24h` or longer | MCP sessions can be long-lived; avoids mid-session expiration |
| Production (HTTP) | `1h` | Shorter-lived tokens reduce risk if leaked |
| CI/CD or scripts | `5m` – `15m` | Minimal exposure window for automated tasks |

The PDF Generator API validates the token on every request. If the token expires mid-session, subsequent API calls will return `401 Unauthorized` — generate a new token and restart the MCP client.

### Security Best Practices

- **Never commit tokens or secret keys** to version control
- Use **environment variables** or a secrets manager to store your `BEARER_TOKEN_JWT`
- **Rotate secret keys** periodically in the PDF Generator API dashboard
- For HTTP mode, use **HTTPS** in production to protect tokens in transit

See: [PDF Generator API Authentication Docs](https://docs.pdfgeneratorapi.com/v4#section/Authentication/Creating-a-JWT)

## Environment Variables

| Variable | Mode | Default | Description |
|----------|------|---------|-------------|
| `API_BASE_URL` | Both | `https://us1.pdfgeneratorapi.com/api/v4` | PDF Generator API base URL |
| `BEARER_TOKEN_JWT` | Stdio | — | JWT token for authentication |
| `PORT` | HTTP | `3000` | Server port |
| `LOG_LEVEL` | Both | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `SESSION_TTL_MINUTES` | HTTP | `30` | Session idle timeout in minutes |
| `CORS_ORIGIN` | HTTP | `*` (all origins) | Comma-separated allowed origins |

Create a `.env` file in the repo root:
```bash
cp .env.example .env
```

## Regenerating

To regenerate after OpenAPI spec changes:
```bash
# Place the updated spec at docs/apiv4.json, then:
./scripts/generate-mcp.sh

# Or specify a custom input:
./scripts/generate-mcp.sh --input /path/to/apiv4.json
```

**Note:** After regeneration, custom patches may need to be re-applied.

## Testing

```bash
npm run build
npm test
```

Test stdio mode manually:
```bash
BEARER_TOKEN_JWT="your-token" echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm run start:stdio
```

Test HTTP mode:
```bash
npm run start:http
curl http://localhost:3000/health
```

## Resources

- [MCP Documentation](https://modelcontextprotocol.io)
- [PDF Generator API Documentation](https://docs.pdfgeneratorapi.com/v4)
- [OpenAPI MCP Generator](https://github.com/anthropics/openapi-mcp-generator)
