/**
 * One log line per request to the MCP endpoint: who called, with which client and
 * credential, what they asked for and how it went. Never the token, and never tool
 * arguments or results, which carry customer documents and data.
 */
import type { MiddlewareHandler } from 'hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { log } from './logger.js';

export const REQUEST_MESSAGE = 'MCP request';

const MAX_TEXT_LENGTH = 200;

// Why a request was answered with this status before it reached the MCP handler
const REFUSALS: Record<number, string> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'unknown_session',
  405: 'method_not_allowed',
  406: 'not_acceptable',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  429: 'rate_limited',
  503: 'unavailable',
};

/** What a client says about itself when it opens a session. */
export interface ClientInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

/** What the endpoint learns about a request while handling it. */
export interface RequestFacts {
  method?: string;
  tool?: string;
  client?: ClientInfo;
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
 * Logs every request to the MCP endpoint once it is answered, including the ones a
 * guard, the token check or a rate limit refused. Registered before them all.
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
      ...identityOf(c.get('authInfo') as AuthInfo | undefined),
      ...clientFields(facts.client),
      http_method: c.req.method,
      method: facts.method,
      tool: facts.tool,
      status,
      outcome: status >= 500 ? 'error' : status >= 400 ? 'refused' : 'ok',
      refusal: status >= 400 ? facts.refusal ?? refusalOf(c.res) : undefined,
      duration_ms: elapsedSince(startedAt),
    });
  };
}

export function logToolCall(record: ToolCallRecord, authInfo: AuthInfo | undefined, client: ClientInfo | undefined): void {
  log.event(REQUEST_MESSAGE, {
    ...identityOf(authInfo),
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

function identityOf(authInfo: AuthInfo | undefined): Record<string, unknown> {
  if (!authInfo) {
    return { credential: 'none' };
  }

  return {
    credential: 'oauth',
    client_id: authInfo.clientId,
    user_id: authInfo.extra?.sub,
    workspace_id: authInfo.extra?.workspaceId,
    organization_id: authInfo.extra?.organizationId,
  };
}

function clientFields(client: ClientInfo | undefined): Record<string, unknown> {
  return {
    client_name: client?.name,
    client_version: client?.version,
    protocol_version: client?.protocolVersion,
  };
}

function refusalOf(response: Response): string | undefined {
  if (response.status === 401) {
    return /error="([^"]+)"/.exec(response.headers.get('WWW-Authenticate') ?? '')?.[1] ?? 'missing_token';
  }

  return REFUSALS[response.status];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : undefined;
}
