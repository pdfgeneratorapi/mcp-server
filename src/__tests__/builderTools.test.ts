import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockAxios = jest.fn() as jest.Mock<any>;
jest.unstable_mockModule('axios', () => ({
  default: Object.assign(mockAxios, { isAxiosError: (e: any) => !!e?.isAxiosError }),
  __esModule: true,
}));

const { API_BASE_URL, BUILDER_BASE_URL } = await import('../config.js');
const { builderToolDefinitionMap, builderToolChangesTemplate } = await import('../builder.js');
const { executeApiTool } = await import('../execute.js');
const { mayCallTool, requiredScopeForCall, visibleTools } = await import('../auth/scopes.js');

const ok = { status: 200, headers: { 'content-type': 'application/json' }, data: Buffer.from('{"response":{"status":"ok"}}') };
const auth = { getToken: async () => 'upstream-token', invalidate: () => {} };

beforeEach(() => {
  mockAxios.mockReset();
});

describe('the template builder address', () => {
  it('is reached in-cluster, not through the public API host', () => {
    expect(API_BASE_URL).toBe('https://test-api.example.com/api/v4');
    expect(BUILDER_BASE_URL).toBe('http://pdf-api-main/api/mcp/builder');
  });
});

describe('running the builder tools', () => {
  it('posts a builder tool call to the template it names', async () => {
    mockAxios.mockResolvedValue(ok);
    const args = { template_id: 42, tool: 'add_page', requestBody: { arguments: { page: {} }, data: { total: 3 } } };

    const result = await executeApiTool('run_builder_tool', builderToolDefinitionMap.get('run_builder_tool')!, args, auth);

    expect(result.isError).toBeUndefined();
    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      url: `${BUILDER_BASE_URL}/templates/42/tools/add_page`,
      data: { arguments: { page: {} }, data: { total: 3 } },
      headers: expect.objectContaining({ authorization: 'Bearer upstream-token' }),
    }));
  });

  it.each([
    ['get_builder_guide', '/guide'],
    ['list_builder_tools', '/tools'],
  ])('reads %s from the builder', async (tool, path) => {
    mockAxios.mockResolvedValue(ok);

    await executeApiTool(tool, builderToolDefinitionMap.get(tool)!, {}, auth);

    expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', url: `${BUILDER_BASE_URL}${path}` }));
  });

  it('refuses a call without a template', async () => {
    const result = await executeApiTool('run_builder_tool', builderToolDefinitionMap.get('run_builder_tool')!, { tool: 'list_pages' }, auth);

    expect(result.isError).toBe(true);
    expect(mockAxios).not.toHaveBeenCalled();
  });
});

describe('the scopes of the builder', () => {
  it.each(['get_template_structure', 'list_pages', 'validate_template'])('reads with %s', (tool) => {
    expect(builderToolChangesTemplate(tool)).toBe(false);
    expect(requiredScopeForCall('run_builder_tool', { tool })).toBe('templates:read');
  });

  it.each(['add_component', 'remove_page', 'rename_template'])('writes with %s', (tool) => {
    expect(requiredScopeForCall('run_builder_tool', { tool })).toBe('templates:write');
  });

  /**
   * The read-only list lives here, the builder's catalogue in the API: a tool the API adds
   * later must not be runnable on a read grant before someone looks at it.
   */
  it('treats a builder tool it does not know as a write', () => {
    expect(requiredScopeForCall('run_builder_tool', { tool: 'a_tool_added_later' })).toBe('templates:write');
    expect(requiredScopeForCall('run_builder_tool', {})).toBe('templates:write');
  });

  it('refuses a change on a read grant and allows it on a write grant', () => {
    const call = { template_id: 1, tool: 'add_component' };

    expect(mayCallTool('run_builder_tool', ['templates:read'], call)).toEqual({ allowed: false, required: 'templates:write' });
    expect(mayCallTool('run_builder_tool', ['templates:write'], call).allowed).toBe(true);
  });

  it('offers the builder to a template-read client and hides it from others', () => {
    expect(visibleTools(['templates:read'])).toEqual(expect.arrayContaining(['get_builder_guide', 'list_builder_tools', 'run_builder_tool']));
    expect(visibleTools(['documents:write'])).not.toContain('run_builder_tool');
  });
});
