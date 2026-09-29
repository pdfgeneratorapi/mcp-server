/**
 * Least-privilege scopes over the tool catalogue: a client that only reads templates
 * cannot delete a workspace.
 */
import { toolDefinitionMap } from '../tools.js';

export type ScopeEnforcement = 'off' | 'warn' | 'enforce';

/** Broader actions cover the narrower ones, within one family. */
const IMPLIED_ACTIONS: Record<string, string[]> = {
  delete: ['write', 'read'],
  write: ['read'],
};

/**
 * The scope each tool needs. null means none: static schemas and the status check carry
 * no customer data.
 */
export const TOOL_SCOPES: Record<string, string | null> = {
  get_status: null,
  get_template_schema: null,
  get_einvoice_schema: null,

  get_templates: 'templates:read',
  get_template: 'templates:read',
  get_template_data: 'templates:read',
  validate_template: 'templates:read',
  list_template_versions: 'templates:read',
  get_template_version: 'templates:read',
  create_template: 'templates:write',
  update_template: 'templates:write',
  import_template: 'templates:write',
  copy_template: 'templates:write',
  promote_template_version: 'templates:write',
  // Opens an editor session that can change the template, whatever its annotation says.
  open_editor: 'templates:write',
  delete_template: 'templates:delete',
  delete_template_version: 'templates:delete',

  get_documents: 'documents:read',
  get_document: 'documents:read',
  get_async_job_status: 'documents:read',
  generate_document: 'documents:write',
  generate_document_async: 'documents:write',
  generate_document_batch: 'documents:write',
  generate_document_batch_async: 'documents:write',
  delete_document: 'documents:delete',

  get_workspaces: 'workspaces:read',
  get_workspace: 'workspaces:read',
  create_workspace: 'workspaces:write',
  delete_workspace: 'workspaces:delete',

  get_forms: 'forms:read',
  get_form: 'forms:read',
  create_form: 'forms:write',
  update_form: 'forms:write',
  import_form: 'forms:write',
  delete_form: 'forms:delete',
  // Mints a public link anyone can open: a different grant from editing a form.
  share_form: 'forms:share',

  add_watermark: 'pdf:write',
  encrypt_document: 'pdf:write',
  decrypt_document: 'pdf:write',
  optimize_document: 'pdf:write',
  make_accessible: 'pdf:write',
  fill_form_fields: 'pdf:write',
  // Posts a caller-supplied file or URL to the PDF services and spends credits.
  extract_form_fields: 'pdf:write',
  convert_html_to_pdf: 'pdf:write',
  convert_url_to_pdf: 'pdf:write',
  generate_qr_code: 'pdf:write',

  create_einvoice: 'einvoice:write',
  create_xrechnung_einvoice: 'einvoice:write',
  create_facturx_einvoice: 'einvoice:write',
};

export function loadScopeEnforcement(env: NodeJS.ProcessEnv = process.env): ScopeEnforcement {
  const mode = env.MCP_SCOPE_ENFORCEMENT;

  return mode === 'off' || mode === 'enforce' || mode === 'warn' ? mode : 'warn';
}

export function requiredScope(toolName: string): string | null {
  return TOOL_SCOPES[toolName] ?? null;
}

/**
 * Every scope a grant covers, the granted ones plus the narrower ones they imply.
 */
export function grantedScopes(scopes: string[]): Set<string> {
  const granted = new Set<string>();

  for (const scope of scopes) {
    granted.add(scope);
    const [family, action] = scope.split(':');

    for (const implied of IMPLIED_ACTIONS[action] ?? []) {
      granted.add(`${family}:${implied}`);
    }
  }

  return granted;
}

/**
 * A token with no scope claim keeps full privilege: tokens issued before scopes existed,
 * and stdio, must not lose access.
 */
export function mayCallTool(toolName: string, scopes: string[]): { allowed: boolean; required: string | null } {
  const required = requiredScope(toolName);

  if (required === null || scopes.length === 0) {
    return { allowed: true, required };
  }

  return { allowed: grantedScopes(scopes).has(required), required };
}

/**
 * The tools a grant may call, so clients never see one they cannot use.
 */
export function visibleTools(scopes: string[]): string[] {
  return [...toolDefinitionMap.keys()].filter(toolName => mayCallTool(toolName, scopes).allowed);
}
