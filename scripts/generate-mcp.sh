#!/usr/bin/env bash
set -e

log() {
  echo "$(date +'%Y-%m-%d %H:%M:%S'): $1"
}

CURRENT_DIR=$PWD
SCRIPT_DIR=$(cd $(dirname $0) && pwd)
REPO_ROOT="$SCRIPT_DIR/.."

# Default OpenAPI spec location
OPEN_API_INPUT="$REPO_ROOT/docs/apiv4.json"

# Output directory (root of the repo)
OUTPUT_DIR="$REPO_ROOT"

# Parse arguments
while [ $# -gt 0 ]; do
    if [[ $1 == "--"* ]]; then
        v="${1/--/}"
        export "$v"="$2"
        shift
    fi
    shift
done

# Use custom input if provided
if [[ ! -z $input ]]; then
  OPEN_API_INPUT="$CURRENT_DIR/$input"
fi

# Check if OpenAPI spec exists
if [[ ! -f $OPEN_API_INPUT ]]; then
  log "ERROR: OpenAPI spec not found at $OPEN_API_INPUT"
  log "Usage: ./generate-mcp.sh --input /path/to/apiv4.json"
  exit 1
fi

log "Using OpenAPI spec: $OPEN_API_INPUT"

# Generate MCP server with streamable-http transport (supports both stdio and HTTP)
log "Generating MCP server with dual transport support (stdio + HTTP)..."
rm -rf "$OUTPUT_DIR/src" "$OUTPUT_DIR/build"
openapi-mcp-generator \
  --input "$OPEN_API_INPUT" \
  --output "$OUTPUT_DIR" \
  --server-name "pdf-generator-api" \
  --transport streamable-http \
  --port 3000 \
  --force

cd "$OUTPUT_DIR" && npm install
log "✓ MCP server generated at: $OUTPUT_DIR"

log ""
log "========================================="
log "MCP Server generated successfully!"
log "========================================="
log ""
log "IMPORTANT: After regeneration, you must re-apply custom patches:"
log "  1. simplifySchemaForOpenAI() in src/index.ts"
log "  2. createMcpServer() factory in src/index.ts"
log "  3. JWT env var rename (JSONWebTokenAuth -> JWT / BEARER_TOKEN_JWT)"
log "  4. API_BASE_URL override in src/index.ts"
log ""
log "Next steps:"
log "  1. For local use (stdio mode): Configure your MCP client (see README.md)"
log "  2. For production (HTTP mode): docker compose up mcp-server"
log "========================================="