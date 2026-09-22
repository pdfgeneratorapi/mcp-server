
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { v4 as uuid } from 'uuid';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InitializeRequestSchema, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";
import { toReqRes, toFetchResponse } from 'fetch-to-node';

// Import server configuration constants and factory
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { createMcpServer } from './server.js';
import { log } from './logger.js';
import type { IncomingMessage } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';
import { buildProtectedResourceMetadata } from './auth/protectedResourceMetadata.js';
import { requireBearerToken } from './auth/middleware.js';
import { createRemoteKeySetProvider } from './auth/asMetadata.js';
import { createTokenVerifier, type TokenVerifier } from './auth/verifier.js';
import { createMintedCredentials, type UpstreamCredentials } from './credentials/upstream.js';

// Constants
const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MINUTES || '30', 10) * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute
const WELL_KNOWN_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const METADATA_CACHE_CONTROL = 'public, max-age=3600';

/**
 * StreamableHTTP MCP Server handler
 */
class MCPStreamableHttpServer {
  // Store active transports and servers by session ID
  transports: {[sessionId: string]: StreamableHTTPServerTransport} = {};
  servers: {[sessionId: string]: Server} = {};
  // Track last activity per session for TTL expiration
  private lastActivity: {[sessionId: string]: number} = {};
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly credentials: UpstreamCredentials) {
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), SESSION_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * Remove sessions that have been idle longer than SESSION_TTL_MS
   */
  private cleanupStaleSessions() {
    const now = Date.now();
    for (const sessionId of Object.keys(this.lastActivity)) {
      if (now - this.lastActivity[sessionId] > SESSION_TTL_MS) {
        log.debug(`Session expired (idle > ${SESSION_TTL_MS / 60000}m): ${sessionId}`);
        this.destroySession(sessionId);
      }
    }
  }

  /**
   * Clean up all resources for a session
   */
  private destroySession(sessionId: string) {
    try {
      this.transports[sessionId]?.close();
    } catch { /* ignore close errors */ }
    delete this.transports[sessionId];
    delete this.servers[sessionId];
    delete this.lastActivity[sessionId];
  }
  
  /**
   * Handle GET requests (typically used for static files)
   */
  async handleGetRequest(c: any) {
    log.debug("GET request received - StreamableHTTP transport only supports POST");
    return c.text('Method Not Allowed', 405, {
      'Allow': 'POST'
    });
  }
  
  /**
   * Handle POST requests (all MCP communication)
   */
  async handlePostRequest(c: any) {
    const sessionId = c.req.header(SESSION_ID_HEADER_NAME);
    log.debug(`POST request received ${sessionId ? 'with session ID: ' + sessionId : 'without session ID'}`);

    try {
      const body = await c.req.json();
      
      // Convert Fetch Request to Node.js req/res, carrying the verified token to the transport,
      // which hands it to request handlers as extra.authInfo
      const { req, res } = toReqRes(c.req.raw);
      (req as IncomingMessage & { auth?: AuthInfo }).auth = c.get('authInfo');
      
      // Reuse existing transport if we have a session ID
      if (sessionId && this.transports[sessionId]) {
        this.lastActivity[sessionId] = Date.now();
        const transport = this.transports[sessionId];
        
        // Handle the request with the transport
        await transport.handleRequest(req, res, body);
        
        // Cleanup when the response ends
        res.on('close', () => {
          log.debug(`Request closed for session ${sessionId}`);
        });
        
        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }
      
      // Create new transport for initialize requests
      if (!sessionId && this.isInitializeRequest(body)) {
        log.debug("Creating new StreamableHTTP transport for initialize request");

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => uuid(),
        });

        // Add error handler for debug purposes
        transport.onerror = (err) => {
          log.error('StreamableHTTP transport error:', err);
        };

        // Create a new MCP server instance for this session; each tool call resolves its
        // API credential from the verified token of that request, never from the header
        const newServer = createMcpServer(this.credentials);

        // Connect the transport to the new MCP server
        await newServer.connect(transport);

        // Handle the request with the transport
        await transport.handleRequest(req, res, body);

        // Store the transport and server if we have a session ID
        const newSessionId = transport.sessionId;
        if (newSessionId) {
          log.debug(`New session established: ${newSessionId}`);
          this.transports[newSessionId] = transport;
          this.servers[newSessionId] = newServer;
          this.lastActivity[newSessionId] = Date.now();

          // Set up clean-up for when the transport is closed
          transport.onclose = () => {
            log.debug(`Session closed: ${newSessionId}`);
            this.destroySession(newSessionId);
          };
        }

        // Cleanup when the response ends
        res.on('close', () => {
          log.debug(`Request closed for new session`);
        });

        // Convert Node.js response back to Fetch Response
        return toFetchResponse(res);
      }
      
      // Invalid request (no session ID and not initialize)
      return c.json(
        this.createErrorResponse("Bad Request: invalid session ID or method."),
        400
      );
    } catch (error) {
      log.error('Error handling MCP request:', error);
      return c.json(
        this.createErrorResponse("Internal server error."),
        500
      );
    }
  }
  
  /**
   * Create a JSON-RPC error response
   */
  private createErrorResponse(message: string): JSONRPCError {
    return {
      jsonrpc: JSON_RPC,
      error: {
        code: -32000,
        message: message,
      },
      id: uuid(),
    };
  }
  
  /**
   * Check if the request is an initialize request
   */
  private isInitializeRequest(body: any): boolean {
    const isInitial = (data: any) => {
      const result = InitializeRequestSchema.safeParse(data);
      return result.success;
    };
    
    if (Array.isArray(body)) {
      return body.some(request => isInitial(request));
    }
    
    return isInitial(body);
  }
}

/**
 * Builds the Hono app with every route, without listening, so tests can drive it
 *
 * @param authConfig OAuth configuration (read from the environment by default)
 * @returns The Hono app instance
 */
export function createHttpApp(
  authConfig: AuthConfig = loadAuthConfig(),
  verifier: TokenVerifier = remoteTokenVerifier(authConfig),
  credentials: UpstreamCredentials = mintedCredentials(authConfig),
) {
  const app = new Hono();
  const protectedResourceMetadata = buildProtectedResourceMetadata(authConfig);

  // Enable CORS - restrict origins in production via CORS_ORIGIN env var
  // e.g. CORS_ORIGIN="https://example.com,https://app.example.com"
  // Browser clients can only read the challenge and the session id when they are exposed.
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use('*', cors({
    origin: corsOrigin ? corsOrigin.split(',').map(o => o.trim()) : '*',
    exposeHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'],
  }));

  // Create MCP handler (creates new server instances per session)
  const mcpHandler = new MCPStreamableHttpServer(credentials);
  
  // Add a simple health check endpoint
  app.get('/health', (c) => {
    return c.json({ status: 'OK', server: SERVER_NAME, version: SERVER_VERSION });
  });

  // Discovery must stay unauthenticated, and must be registered before the static catch-all
  // below, which would otherwise answer these paths with index.html.
  const serveProtectedResourceMetadata = (c: any) =>
    c.json(protectedResourceMetadata, 200, { 'Cache-Control': METADATA_CACHE_CONTROL });
  app.get(authConfig.resourceMetadataPath, serveProtectedResourceMetadata);
  app.get(WELL_KNOWN_PROTECTED_RESOURCE_PATH, serveProtectedResourceMetadata);
  app.all('/.well-known/*', (c) => c.json({ error: 'not_found' }, 404));

  // Main MCP endpoint supporting both GET and POST
  app.use('/mcp', requireBearerToken(authConfig, verifier));
  app.get("/mcp", (c) => mcpHandler.handleGetRequest(c));
  app.post("/mcp", (c) => mcpHandler.handlePostRequest(c));
  
  // Static files for the web client (if any)
  app.get('/*', async (c) => {
    const filePath = c.req.path === '/' ? '/index.html' : c.req.path;
    try {
      // Use Node.js fs to serve static files
      const fs = await import('fs');
      const path = await import('path');
      const { fileURLToPath } = await import('url');
      
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const publicPath = path.join(__dirname, '..', 'public');
      const fullPath = path.join(publicPath, filePath);
      
      // Simple security check to prevent directory traversal
      if (!fullPath.startsWith(publicPath)) {
        return c.text('Forbidden', 403);
      }
      
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(fullPath);
          
          // Set content type based on file extension
          const ext = path.extname(fullPath).toLowerCase();
          let contentType = 'text/plain';
          
          switch (ext) {
            case '.html': contentType = 'text/html'; break;
            case '.css': contentType = 'text/css'; break;
            case '.js': contentType = 'text/javascript'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
            case '.jpg': contentType = 'image/jpeg'; break;
            case '.svg': contentType = 'image/svg+xml'; break;
          }
          
          return new Response(content, {
            headers: { 'Content-Type': contentType }
          });
        }
      } catch {
        // File not found or other error
        return c.text('Not Found', 404);
      }
    } catch (err) {
      log.error('Error serving static file:', err);
      return c.text('Internal Server Error', 500);
    }
    
    return c.text('Not Found', 404);
  });

  return app;
}

function mintedCredentials(authConfig: AuthConfig): UpstreamCredentials {
  return createMintedCredentials({ url: authConfig.credentialsUrl, issuer: authConfig.issuer });
}

function remoteTokenVerifier(authConfig: AuthConfig): TokenVerifier {
  return createTokenVerifier({
    issuer: authConfig.issuer,
    audience: authConfig.resource,
    keySet: createRemoteKeySetProvider(authConfig),
  });
}

/**
 * Sets up a web server for the MCP server using StreamableHTTP transport
 *
 * @param port The port to listen on (default: 3000)
 * @param options Overrides for the OAuth configuration, token verifier and API credentials (tests)
 * @returns The Hono app instance, the HTTP server, and the actual listening port
 */
export async function setupStreamableHttpServer(
  port = 3000,
  options: { authConfig?: AuthConfig; verifier?: TokenVerifier; credentials?: UpstreamCredentials } = {},
) {
  const authConfig = options.authConfig ?? loadAuthConfig();
  const app = createHttpApp(
    authConfig,
    options.verifier ?? remoteTokenVerifier(authConfig),
    options.credentials ?? mintedCredentials(authConfig),
  );

  // Start the server
  const server = serve({
    fetch: app.fetch,
    port
  }, (info) => {
    log.info(`MCP StreamableHTTP Server running at http://localhost:${info.port}`);
    log.info(`- MCP Endpoint: http://localhost:${info.port}/mcp`);
    log.info(`- Health Check: http://localhost:${info.port}/health`);
  });

  // Resolve the actual listening port (useful when port=0)
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return Object.assign(app, { server, port: actualPort });
}
