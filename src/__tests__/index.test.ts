import { describe, it, expect } from '@jest/globals';

/**
 * Tests for submodules and logger coverage.
 * Note: index.ts runs main() on import, so we test its re-exports
 * via their source modules to avoid triggering the entry point.
 */

describe('config module', () => {
  it('should export SERVER_NAME', async () => {
    const { SERVER_NAME } = await import('../config.js');
    expect(SERVER_NAME).toBe('pdf-generator-api');
  });

  it('should export SERVER_VERSION', async () => {
    const { SERVER_VERSION } = await import('../config.js');
    expect(typeof SERVER_VERSION).toBe('string');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('should export API_BASE_URL with default or env override', async () => {
    const { API_BASE_URL } = await import('../config.js');
    expect(typeof API_BASE_URL).toBe('string');
    expect(API_BASE_URL).toMatch(/^https?:\/\//);
  });
});

describe('logger module', () => {
  it('should export all log level functions', async () => {
    const { log } = await import('../logger.js');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  it('should call warn without throwing', async () => {
    const { log } = await import('../logger.js');
    expect(() => log.warn('test warning message')).not.toThrow();
  });

  it('should call debug without throwing', async () => {
    const { log } = await import('../logger.js');
    expect(() => log.debug('test debug message')).not.toThrow();
  });

  it('should call info without throwing', async () => {
    const { log } = await import('../logger.js');
    expect(() => log.info('test info message')).not.toThrow();
  });

  it('should call error without throwing', async () => {
    const { log } = await import('../logger.js');
    expect(() => log.error('test error message')).not.toThrow();
  });
});

describe('types module', () => {
  it('should be importable without errors', async () => {
    const types = await import('../types.js');
    expect(types).toBeDefined();
  });
});
