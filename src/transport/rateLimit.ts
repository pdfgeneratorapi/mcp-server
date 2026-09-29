/**
 * Per-identity rate limits on the MCP endpoint. Behind a load balancer every request carries the
 * same address, so the limit follows the verified token's subject and client instead of the IP.
 * Counters live in this process: with several replicas the limit applies per replica.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { log } from '../logger.js';

const DEFAULT_REQUESTS_PER_MINUTE = 600;
const DEFAULT_INITIALIZE_PER_MINUTE = 30;
const MAX_TRACKED_IDENTITIES = 10_000;
const MS_PER_MINUTE = 60_000;

export interface RateLimits {
  /** Requests one identity may make per minute; 0 turns the limit off. */
  requestsPerMinute: number;
  /** Sessions one identity may open per minute, each costing server memory; 0 turns it off. */
  initializePerMinute: number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export function loadRateLimits(env: NodeJS.ProcessEnv = process.env): RateLimits {
  return {
    requestsPerMinute: wholeNumber(env, 'MCP_REQUESTS_PER_MINUTE', DEFAULT_REQUESTS_PER_MINUTE),
    initializePerMinute: wholeNumber(env, 'MCP_INITIALIZE_PER_MINUTE', DEFAULT_INITIALIZE_PER_MINUTE),
  };
}

/**
 * A token bucket per key: a key may spend its whole minute's allowance at once, then earns it
 * back evenly over the minute.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_TRACKED_IDENTITIES,
  ) {}

  take(key: string): RateDecision {
    if (this.perMinute === 0) {
      return { allowed: true };
    }

    const now = this.now();
    const bucket = this.refilled(this.buckets.get(key), now);

    if (bucket.tokens >= 1) {
      this.remember(key, { tokens: bucket.tokens - 1, updatedAt: now });
      return { allowed: true };
    }

    this.remember(key, bucket);

    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) * MS_PER_MINUTE / this.perMinute / 1000)) };
  }

  size(): number {
    return this.buckets.size;
  }

  private refilled(bucket: Bucket | undefined, now: number): Bucket {
    if (!bucket) {
      return { tokens: this.perMinute, updatedAt: now };
    }

    const earned = (now - bucket.updatedAt) * this.perMinute / MS_PER_MINUTE;

    return { tokens: Math.min(this.perMinute, bucket.tokens + earned), updatedAt: now };
  }

  private remember(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    if (this.buckets.size > this.maxKeys) {
      this.prune();
    }
  }

  /** Forgets identities whose allowance is full again, then the least recently seen. */
  private prune(): void {
    const now = this.now();

    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now).tokens >= this.perMinute) {
        this.buckets.delete(key);
      }
    }

    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) {
        break;
      }
      this.buckets.delete(key);
    }
  }
}

export function identityKey(issuer: string, authInfo: AuthInfo | undefined): string | undefined {
  const subject = authInfo?.extra?.sub;

  if (typeof subject !== 'string' || subject === '' || !authInfo?.clientId) {
    return undefined;
  }

  return JSON.stringify([issuer, subject, authInfo.clientId]);
}

export function tooManyRequests(c: Context, retryAfterSeconds: number, what: string): Response {
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: `Too Many Requests: ${what}; retry after ${retryAfterSeconds} seconds.` },
      id: null,
    },
    429,
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

/**
 * Must run after the bearer token is verified: the limit follows the identity it names.
 */
export function limitRequests(limiter: RateLimiter, issuer: string): MiddlewareHandler {
  return async (c, next) => {
    const key = identityKey(issuer, c.get('authInfo') as AuthInfo | undefined);

    if (key !== undefined) {
      const decision = limiter.take(key);

      if (!decision.allowed) {
        log.warn('Rate limited an MCP client', { key, retryAfterSeconds: decision.retryAfterSeconds });
        return tooManyRequests(c, decision.retryAfterSeconds, 'request limit reached');
      }
    }

    await next();
  };
}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();

  if (raw === undefined || raw === '') {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a whole number of 0 or more (0 turns the limit off), got "${raw}"`);
  }

  return Number(raw);
}
