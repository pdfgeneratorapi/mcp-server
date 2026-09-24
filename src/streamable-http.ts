
/**
 * StreamableHTTP server setup for HTTP-based MCP communication using Hono
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { v4 as uuid } from 'uuid';
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InitializeRequestSchema, JSONRPCError } from "@modelcontextprotocol/sdk/types.js";

// Import server configuration constants and factory
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { createMcpServer } from './server.js';
import { log } from './logger.js';
import { loadAuthConfig, type AuthConfig } from './auth/config.js';
import { buildProtectedResourceMetadata } from './auth/protectedResourceMetadata.js';
import { requireBearerToken } from './auth/middleware.js';
import { createRemoteKeySetProvider } from './auth/asMetadata.js';
import { createTokenVerifier, type TokenVerifier } from './auth/verifier.js';
import { createMintedCredentials, type UpstreamCredentials } from './credentials/upstream.js';
import { createInMemorySessionStore, ownedBy, ownerOf, type SessionStore } from './sessions/store.js';
import { guardRequests, loadTransportLimits } from './transport/guards.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { loadScopeEnforcement, mayCallTool } from './auth/scopes.js';
import { challenges } from './auth/challenges.js';

// Constants
const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MINUTES || '30', 10) * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute
const SESSION_RETRY_AFTER_SECONDS = '60';
const WELL_KNOWN_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
const METADATA_CACHE_CONTROL = 'public, max-age=3600';

/**
 * StreamableHTTP MCP Server handler
 */
class MCPStreamableHttpServer {
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly credentials: UpstreamCredentials,
    private readonly resourceMetadataUrl: string,
    private readonly issuer: string,
    private readonly maxSessions: number,
    private readonly sessions: SessionStore = createInMemorySessionStore(),
  ) {
    this.cleanupTimer = setInterval(() => this.cleanupStaleSessions(), SESSION_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * Remove sessions that have been idle longer than SESSION_TTL_MS
   */
  private cleanupStaleSessions() {
    for (const sessionId of this.sessions.expired(SESSION_TTL_MS, Date.now())) {
      log.debug(`Session expired (idle > ${SESSION_TTL_MS / 60000}m): ${sessionId}`);
      this.destroySession(sessionId);
    }
  }

  /**
   * Clean up all resources for a session
   */
  private destroySession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return;
    }

    // Forget it first: closing the transport calls back into onclose.
    this.sessions.delete(sessionId);

    try {
      session.transport.close();
    } catch { /* ignore close errors */ }
  }

  /**
   * The session of this request, or null when it belongs to nobody the caller is.
   * An unknown and a foreign session answer alike, so session ids cannot be probed.
   */
  private ownSession(c: any, sessionId: string) {
    const owner = ownerOf(this.issuer, c.get('authInfo'));
    const session = this.sessions.get(sessionId);

    if (!owner || !session || !ownedBy(session, owner)) {
      log.warn(`Refused session "${sessionId}" for another identity`);
      return null;
    }

    return session;
  }

  /**
   * Handle DELETE requests (spec session termination)
   */
  async handleDeleteRequest(c: any) {
    const sessionId = c.req.header(SESSION_ID_HEADER_NAME);

    if (!sessionId || !this.ownSession(c, sessionId)) {
      return c.json(this.createErrorResponse('Not Found: unknown session.'), 404);
    }

    this.destroySession(sessionId);
    log.debug(`Session terminated: ${sessionId}`);

    return c.body(null, 204);
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
    const authInfo = c.get('authInfo');
    log.debug(`POST request received ${sessionId ? 'with session ID: ' + sessionId : 'without session ID'}`);

    try {
      // Read the body from a copy: the transport needs the request untouched
      const body = await c.req.raw.clone().json();
      const refusal = this.scopeRefusal(body, authInfo);

      // A single call can be answered with the step-up challenge a client can act on;
      // a batch cannot, so its elements are refused one by one by the tool handler.
      if (refusal) {
        return c.json(refusal.body, refusal.status, { 'WWW-Authenticate': refusal.wwwAuthenticate });
      }

      // Reuse the session only for the identity that opened it
      if (sessionId) {
        const session = this.ownSession(c, sessionId);

        if (!session) {
          return c.json(this.createErrorResponse('Not Found: unknown session.'), 404);
        }

        this.sessions.touch(sessionId);

        return await session.transport.handleRequest(c.req.raw, { authInfo });
      }

      // Create new transport for initialize requests
      if (this.isInitializeRequest(body)) {
        const owner = ownerOf(this.issuer, authInfo);

        if (!owner) {
          log.error('Refusing a session: the verified token names no subject or client');
          return c.json(this.createErrorResponse('Unauthorized: the access token names no subject.'), 401);
        }

        if (this.sessions.size() >= this.maxSessions) {
          log.warn(`Refused a new session: at capacity (${this.maxSessions})`);
          return c.json(
            this.createErrorResponse('Service Unavailable: session capacity reached.'),
            503,
            { 'Retry-After': SESSION_RETRY_AFTER_SECONDS },
          );
        }

        log.debug("Creating new StreamableHTTP transport for initialize request");

        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => uuid(),
          onsessionclosed: (closedSessionId: string) => {
            log.debug(`Session closed: ${closedSessionId}`);
            this.destroySession(closedSessionId);
          },
        });

        transport.onerror = (err) => {
          log.error('StreamableHTTP transport error:', err);
        };

        // Each tool call resolves its API credential from the verified token of that
        // request, never from the header
        const newServer = createMcpServer(this.credentials);
        await newServer.connect(transport);

        const response = await transport.handleRequest(c.req.raw, { authInfo });
        const newSessionId = transport.sessionId;

        if (newSessionId) {
          log.debug(`New session established: ${newSessionId}`);
          this.sessions.add(newSessionId, { transport, server: newServer, owner, lastActivity: Date.now() });
        }

        return response;
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
   * The step-up challenge for a single tools/call the grant does not cover.
   */
  private scopeRefusal(body: unknown, authInfo: AuthInfo | undefined) {
    if (loadScopeEnforcement() !== 'enforce' || Array.isArray(body)) {
      return null;
    }

    const request = body as { method?: string; params?: { name?: string } };

    if (request?.method !== 'tools/call' || typeof request.params?.name !== 'string') {
      return null;
    }

    const decision = mayCallTool(request.params.name, authInfo?.scopes ?? []);

    if (decision.allowed || decision.required === null) {
      return null;
    }

    log.warn(`Refused "${request.params.name}": the token does not grant "${decision.required}"`);

    return challenges.insufficientScope(this.resourceMetadataUrl, [decision.required]);
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
  const limits = loadTransportLimits(authConfig.resource);
  const mcpHandler = new MCPStreamableHttpServer(credentials, authConfig.resourceMetadataUrl, authConfig.issuer, limits.maxSessions);
  
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
  app.use('/mcp', guardRequests(limits));
  app.use('/mcp', requireBearerToken(authConfig, verifier));
  app.get("/mcp", (c) => mcpHandler.handleGetRequest(c));
  app.post("/mcp", (c) => mcpHandler.handlePostRequest(c));
  app.delete("/mcp", (c) => mcpHandler.handleDeleteRequest(c));
  
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
