#!/usr/bin/env node
/**
 * MCP Server for PDF Generator API v4
 * Entry point — delegates to modular components
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setupStreamableHttpServer } from "./streamable-http.js";
import { createMcpServer } from './server.js';
import { log } from './logger.js';

// Re-export public API for consumers
export { log } from './logger.js';
export { type McpToolDefinition, type JsonObject } from './types.js';
export { SERVER_NAME, SERVER_VERSION, API_BASE_URL } from './config.js';
export { simplifySchemaForOpenAI } from './schema.js';
export { createMcpServer } from './server.js';
export { executeApiTool } from './execute.js';

/**
 * Main function to start the server
 */
async function main() {
  // Determine transport mode from command line arguments
  const args = process.argv.slice(2);
  const transportArg = args.find(arg => arg.startsWith('--transport='));
  const transport = transportArg ? transportArg.split('=')[1] : 'stdio';

  if (transport === 'streamable-http') {
    // Set up StreamableHTTP transport
    log.info('Starting MCP server in HTTP mode...');
    try {
      const port = parseInt(process.env.PORT || '3000', 10);
      await setupStreamableHttpServer(port);
    } catch (error) {
      log.error("Error setting up StreamableHTTP server:", error);
      process.exit(1);
    }
  } else {
    // Set up Stdio transport (default)
    log.info('Starting MCP server in stdio mode...');
    try {
      // In stdio mode, read bearer token from environment variable
      const bearerToken = process.env.BEARER_TOKEN_JWT;
      if (bearerToken) {
        log.debug('Bearer token configured from BEARER_TOKEN_JWT');
      } else {
        log.warn('No BEARER_TOKEN_JWT found - API calls may fail without authentication');
      }

      const stdioServer = createMcpServer(bearerToken);
      const transport = new StdioServerTransport();
      await stdioServer.connect(transport);
      log.info('MCP server running in stdio mode');
    } catch (error) {
      log.error("Error setting up stdio transport:", error);
      process.exit(1);
    }
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    log.info("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
main().catch((error) => {
  log.error("Fatal error in main execution:", error);
  process.exit(1);
});
