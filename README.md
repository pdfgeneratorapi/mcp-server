# AR API MCP Server

Model Context Protocol (MCP) server for the PDF Generator API, generated from the OpenAPI v4 specification.

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
    "ar-api": {
      "command": "node",
      "args": ["/path/to/mcp-server-v4/build/index.js"],
      "env": {
        "API_BASE_URL": "https://us1.pdfgeneratorapi.com/api/v4",
        "BEARER_TOKEN_JWT": "your-jwt-token-here"
      }
    }
  }
}
```

**Note**: Replace `/path/to/mcp-server-v4` with your actual path and `your-jwt-token-here` with your PDF Generator API JWT token.

**Common config locations**:
- **Claude Desktop**: Settings → Developer → Edit Config
- **Claude Code (CLI)**: `~/.claude/mcp_config.json`
- **Cline/Roo-Codeium**: `.vscode/mcp_config.json`
- **Continue**: `~/.continue/config.json`

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

**HTTP Mode**: Pass the Bearer token in the Authorization header with each request:
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer your-jwt-token-here" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'
```

**Stdio Mode**: Pass the Bearer token via the `BEARER_TOKEN_JWT` environment variable in your MCP client config.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_BASE_URL` | No | `https://us1.pdfgeneratorapi.com/api/v4` | PDF Generator API base URL |
| `PORT` | No | `3000` | Server port (HTTP mode only) |
| `BEARER_TOKEN_JWT` | No | - | JWT token (stdio mode only) |
| `LOG_LEVEL` | No | `info` | Logging level |

Create a `.env` file in the repo root:
```bash
cp .env.example .env
```

## JWT Token Generation

Generate a JWT token using your PDF Generator API credentials:

```javascript
const jwt = require('jsonwebtoken');

const token = jwt.sign(
  { iss: 'YOUR_WORKSPACE_ID', sub: 'YOUR_WORKSPACE_IDENTIFIER' },
  'YOUR_SECRET_KEY',
  { algorithm: 'HS256', expiresIn: '1h' }
);
```

See: https://docs.pdfgeneratorapi.com/v4#section/Authentication/Creating-a-JWT

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

Test stdio mode:
```bash
npm run build
BEARER_TOKEN_JWT="your-token" echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npm run start:stdio
```

Test HTTP mode:
```bash
npm run start:http
curl http://localhost:3000/health
```

See [POSTMAN_TESTING.md](POSTMAN_TESTING.md) for detailed testing instructions with Postman.

## Resources

- [MCP Documentation](https://modelcontextprotocol.io)
- [PDF Generator API Documentation](https://docs.pdfgeneratorapi.com/v4)
- [OpenAPI MCP Generator](https://github.com/anthropics/openapi-mcp-generator)
