/**
 * One log line per request to the MCP endpoint: who called, with which client and
 * credential, what they asked for and how it went. Never the token, and never tool
 * arguments or results, which carry customer documents and data.
 */
import type { MiddlewareHandler } from 'hono';
import { log } from './logger.js';

export const REQUEST_MESSAGE = 'MCP request';

const MAX_TEXT_LENGTH = 200;
const BEARER_PREFIX = 'Bearer ';

// Why a request was answered with this status before it reached the MCP handler
const REFUSALS: Record<number, string> = {
  400: 'bad_request',
  404: 'unknown_session',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  415: 'unsupported_media_type',
};

/** What a client says about itself when it opens a session. */
export interface ClientInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** Who a request acts for, as the log line shows it. */
export type Identity = Record<string, unknown>;

/** What the endpoint learns about a request while handling it. */
export interface RequestFacts {
  method?: string;
  tool?: string;
  client?: ClientInfo;
  /** The identity of the token the session acts with, which can differ from this request's header. */
  identity?: Identity;
  refusal?: string;
  /** A tools/call handed to the tool handler, which logs it once the outcome is known. */
  deferred?: boolean;
}

export interface ToolCallRecord {
  tool: string;
  outcome: 'ok' | 'error' | 'refused';
  refusal?: string;
  upstreamStatus?: number;
  durationMs: number;
}

/**
 * The workspace and API key a hand-made token names, read without verifying it: the
 * signature is checked by the API, with a secret this server does not hold.
 */
export function identityOf(token: string | undefined): Identity {
  if (!token) {
    return { credential: 'none' };
  }

  const claims = claimsOf(token);
  const issuedAt = claims?.iat;
  const expiresAt = claims?.exp;

  return {
    credential: 'legacy-jwt',
    workspace_identifier: text(claims?.sub),
    api_key: text(claims?.iss),
    token_lifetime_s: typeof issuedAt === 'number' && typeof expiresAt === 'number' ? expiresAt - issuedAt : undefined,
  };
}

export function bearerTokenOf(authorization: string | undefined): string | undefined {
  return authorization?.startsWith(BEARER_PREFIX) ? authorization.substring(BEARER_PREFIX.length) : undefined;
}

export function clientInfoOf(initialize: unknown): ClientInfo {
  const params = (initialize as {
    params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown; version?: unknown } };
  } | null)?.params;

  return {
    name: text(params?.clientInfo?.name),
    version: text(params?.clientInfo?.version),
    protocolVersion: text(params?.protocolVersion),
  };
}

export function describeRequest(body: unknown): Pick<RequestFacts, 'method' | 'tool'> {
  if (Array.isArray(body)) {
    return { method: 'batch' };
  }

  const request = body as { method?: unknown; params?: { name?: unknown } } | null;

  return {
    method: text(request?.method),
    tool: request?.method === 'tools/call' ? text(request.params?.name) : undefined,
  };
}

/**
 * Logs every request to the MCP endpoint once it is answered.
 */
export function logRequests(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    const facts: RequestFacts = {};
    c.set('telemetry', facts);

    await next();

    if (facts.deferred) {
      return;
    }

    const status = c.res.status;

    log.event(REQUEST_MESSAGE, {
      ...(facts.identity ?? identityOf(bearerTokenOf(c.req.header('Authorization')))),
      ...clientFields(facts.client),
      http_method: c.req.method,
      method: facts.method,
      tool: facts.tool,
      status,
      outcome: status >= 500 ? 'error' : status >= 400 ? 'refused' : 'ok',
      refusal: status >= 400 ? facts.refusal ?? REFUSALS[status] : undefined,
      duration_ms: elapsedSince(startedAt),
    });
  };
}

export function logToolCall(record: ToolCallRecord, identity: Identity, client: ClientInfo | undefined): void {
  log.event(REQUEST_MESSAGE, {
    ...identity,
    ...clientFields(client),
    http_method: 'POST',
    method: 'tools/call',
    tool: record.tool,
    outcome: record.outcome,
    refusal: record.refusal,
    upstream_status: record.upstreamStatus,
    duration_ms: record.durationMs,
  });
}

export function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function clientFields(client: ClientInfo | undefined): Record<string, unknown> {
  return {
    client_name: client?.name,
    client_version: client?.version,
    protocol_version: client?.protocolVersion,
  };
}

function claimsOf(token: string): Record<string, unknown> | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));

    return typeof claims === 'object' && claims !== null ? claims as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : undefined;
}
