/**
 * Guards on the MCP endpoint: which hosts and origins may reach it, and how large a
 * request may be.
 */
import type { MiddlewareHandler } from 'hono';
import { log } from '../logger.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface TransportLimits {
  /** Hosts the MCP endpoint answers for; a request for any other host is refused. */
  allowedHosts: string[];
  /** Origins allowed to call it. Empty means any, which is what desktop clients need. */
  allowedOrigins: string[];
  maxBodyBytes: number;
  maxSessions: number;
}

export function loadTransportLimits(resource: string, env: NodeJS.ProcessEnv = process.env): TransportLimits {
  const corsOrigin = (env.CORS_ORIGIN ?? '').trim();
  const allowedOrigins = corsOrigin === '' || corsOrigin === '*'
    ? []
    : corsOrigin.split(',').map(origin => origin.trim()).filter(Boolean);

  return {
    allowedHosts: [
      new URL(resource).host,
      ...(env.MCP_ALLOWED_HOSTS ?? '').split(',').map(host => host.trim()).filter(Boolean),
    ],
    allowedOrigins,
    maxBodyBytes: Number(env.MCP_MAX_BODY_BYTES ?? 1024 * 1024),
    maxSessions: Number(env.MCP_MAX_SESSIONS ?? 1000),
  };
}

function hostAllowed(host: string, allowedHosts: string[]): boolean {
  if (host === '') {
    return false;
  }

  // Loopback stays open so local development and tests work whatever the resource is.
  return allowedHosts.includes(host) || LOOPBACK_HOSTS.has(host.replace(/:\d+$/, ''));
}

/**
 * Refuses a request whose Host or Origin this server does not answer for, which is how
 * DNS rebinding arrives (MCP authorization spec).
 */
export function guardRequests(limits: TransportLimits): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('Host') ?? new URL(c.req.url).host).toLowerCase();

    if (!hostAllowed(host, limits.allowedHosts)) {
      log.warn(`Refused a request for host "${host}"`);
      return c.json({ error: 'forbidden', error_description: 'Unknown host' }, 403);
    }

    const origin = c.req.header('Origin');

    if (origin !== undefined && limits.allowedOrigins.length > 0 && !limits.allowedOrigins.includes(origin)) {
      log.warn(`Refused a request from origin "${origin}"`);
      return c.json({ error: 'forbidden', error_description: 'Origin not allowed' }, 403);
    }

    const declaredLength = Number(c.req.header('Content-Length') ?? 0);

    if (declaredLength > limits.maxBodyBytes) {
      return c.json({ error: 'payload_too_large', error_description: 'Request body is too large' }, 413);
    }

    await next();
  };
}
