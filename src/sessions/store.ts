/**
 * Sessions of the HTTP transport, and who owns them.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** Who a session belongs to. Never the token itself, so a refreshed token keeps working. */
export interface SessionOwner {
  issuer: string;
  subject: string;
  clientId: string;
  /** Absent for grants approved before the organization was recorded. */
  organizationId?: number;
}

export interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  owner: SessionOwner;
  lastActivity: number;
}

export interface SessionStore {
  get(sessionId: string): Session | undefined;
  add(sessionId: string, session: Session): void;
  touch(sessionId: string): void;
  delete(sessionId: string): void;
  size(): number;
  expired(idleMs: number, now: number): string[];
}

export function ownerOf(issuer: string, authInfo: AuthInfo | undefined): SessionOwner | undefined {
  const subject = authInfo?.extra?.sub;

  if (typeof subject !== 'string' || subject === '' || !authInfo?.clientId) {
    return undefined;
  }

  const organizationId = authInfo.extra?.organizationId;

  return {
    issuer,
    subject,
    clientId: authInfo.clientId,
    organizationId: typeof organizationId === 'number' ? organizationId : undefined,
  };
}

export function ownedBy(session: Session, owner: SessionOwner): boolean {
  return session.owner.issuer === owner.issuer
    && session.owner.subject === owner.subject
    && session.owner.clientId === owner.clientId
    && session.owner.organizationId === owner.organizationId;
}

/**
 * The default store. One process holds its own sessions; a shared backend would
 * implement the same interface.
 */
export function createInMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>();

  return {
    get: (sessionId) => sessions.get(sessionId),
    add: (sessionId, session) => { sessions.set(sessionId, session); },
    touch: (sessionId) => {
      const session = sessions.get(sessionId);

      if (session) {
        session.lastActivity = Date.now();
      }
    },
    delete: (sessionId) => { sessions.delete(sessionId); },
    size: () => sessions.size,
    expired: (idleMs, now) => [...sessions.entries()]
      .filter(([, session]) => now - session.lastActivity > idleMs)
      .map(([sessionId]) => sessionId),
  };
}
