/**
 * Log level utility — gates verbose output behind LOG_LEVEL=debug.
 * All output goes to stderr to avoid interfering with MCP stdio transport.
 */
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const log = {
  debug: (...args: unknown[]) => { if (LOG_LEVEL === 'debug') console.error(...args); },
  info:  (...args: unknown[]) => { console.error(...args); },
  warn:  (...args: unknown[]) => { console.error(...args); },
  error: (...args: unknown[]) => { console.error(...args); },
};
