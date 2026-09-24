import { describe, it, expect, jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: Object.assign(jest.fn(), { isAxiosError: () => false }),
  __esModule: true,
}));

const { TOOL_SCOPES, grantedScopes, requiredScope, mayCallTool, visibleTools, loadScopeEnforcement } = await import('../auth/scopes.js');
const { toolDefinitionMap } = await import('../tools.js');

describe('the tool-to-scope map', () => {
  /**
   * tools.ts is generated from the OpenAPI document, so a regenerated catalogue must not
   * be able to ship a tool nobody scoped.
   */
  it('covers exactly the tools the server exposes', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual([...toolDefinitionMap.keys()].sort());
  });

  it.each([
    ['get_templates', 'templates:read'],
    ['create_template', 'templates:write'],
    ['delete_template', 'templates:delete'],
    ['open_editor', 'templates:write'],
    ['generate_document', 'documents:write'],
    ['delete_document', 'documents:delete'],
    ['create_workspace', 'workspaces:write'],
    ['share_form', 'forms:share'],
    ['extract_form_fields', 'pdf:write'],
    ['convert_html_to_pdf', 'pdf:write'],
    ['create_xrechnung_einvoice', 'einvoice:write'],
  ])('asks for %s to need %s', (tool, scope) => {
    expect(requiredScope(tool)).toBe(scope);
  });

  it.each(['get_status', 'get_template_schema', 'get_einvoice_schema'])('needs no scope for %s', (tool) => {
    expect(requiredScope(tool)).toBeNull();
  });

  /**
   * open_editor and extract_form_fields were annotated read-only; both write.
   */
  it.each(['open_editor', 'extract_form_fields'])('does not treat %s as a read', (tool) => {
    expect(requiredScope(tool)).toMatch(/:write$/);
  });
});

describe('granted scopes', () => {
  it('lets a broader scope cover the narrower ones of its family', () => {
    const granted = grantedScopes(['templates:delete']);

    expect(granted.has('templates:delete')).toBe(true);
    expect(granted.has('templates:write')).toBe(true);
    expect(granted.has('templates:read')).toBe(true);
    expect(granted.has('documents:read')).toBe(false);
  });

  it('keeps forms:share to itself, because sharing is not part of editing', () => {
    const granted = grantedScopes(['forms:write']);

    expect(granted.has('forms:read')).toBe(true);
    expect(granted.has('forms:share')).toBe(false);
  });

  it('ignores a scope it does not know', () => {
    expect(grantedScopes(['made:up']).has('made:up')).toBe(true);
    expect(grantedScopes(['made:up']).has('templates:read')).toBe(false);
  });
});

describe('may call a tool', () => {
  /**
   * Tokens issued before scopes existed, and stdio, carry no scope claim; they keep the
   * full privilege they have always had.
   */
  it('allows everything for a token that carries no scopes', () => {
    expect(mayCallTool('delete_workspace', []).allowed).toBe(true);
  });

  it('allows a tool the granted scope covers', () => {
    expect(mayCallTool('get_templates', ['templates:write']).allowed).toBe(true);
  });

  it('refuses a tool outside the grant and names the scope it needs', () => {
    const decision = mayCallTool('delete_template', ['templates:write']);

    expect(decision.allowed).toBe(false);
    expect(decision.required).toBe('templates:delete');
  });

  it('always allows a tool that needs no scope', () => {
    expect(mayCallTool('get_status', ['templates:read']).allowed).toBe(true);
  });
});

describe('the visible tools', () => {
  it('shows a template-read client exactly the template reads and the unscoped tools', () => {
    const visible = visibleTools(['templates:read']);

    expect(visible).toContain('get_templates');
    expect(visible).toContain('get_template_data');
    expect(visible).toContain('get_status');
    expect(visible).not.toContain('create_template');
    expect(visible).not.toContain('delete_template');
    expect(visible).not.toContain('generate_document');
  });

  it('shows everything to a token without scopes', () => {
    expect(visibleTools([]).length).toBe(toolDefinitionMap.size);
  });
});

describe('enforcement mode', () => {
  it('warns rather than blocks by default, so a mapping mistake cannot lock users out', () => {
    expect(loadScopeEnforcement({})).toBe('warn');
  });

  it.each(['off', 'warn', 'enforce'])('reads %s from the environment', (mode) => {
    expect(loadScopeEnforcement({ MCP_SCOPE_ENFORCEMENT: mode })).toBe(mode);
  });

  it('falls back to warn for a value it does not understand', () => {
    expect(loadScopeEnforcement({ MCP_SCOPE_ENFORCEMENT: 'strict' })).toBe('warn');
  });
});
