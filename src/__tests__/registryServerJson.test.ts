import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_VERSION } from '../config.js';
import { loadAuthConfig } from '../auth/config.js';

const read = (file: string) => JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));

/** The MCP Registry lists what server.json says, so it has to describe the release. */
describe('server.json', () => {
  const serverJson = read('server.json');

  it('carries the released version', () => {
    expect(serverJson.version).toBe(SERVER_VERSION);
    expect(serverJson.version).toBe(read('package.json').version);
  });

  it('points at the hosted endpoint', () => {
    expect(serverJson.remotes).toEqual([{ type: 'streamable-http', url: loadAuthConfig({}).resource }]);
  });

  it('keeps the description within the registry limit', () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });
});
