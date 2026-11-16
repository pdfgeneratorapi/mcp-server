/**
 * The catalogue as operations, which a client finds with a search, reads up on and runs, instead
 * of loading one tool per operation.
 */
import type { McpToolDefinition } from './types.js';
import { catalogue } from './catalogue.js';
import { toolAnnotations } from './annotations.js';
import { simplifySchemaForOpenAI } from './schema.js';
import { requiredScope } from './auth/scopes.js';
import { RUN_BUILDER_TOOL, builderToolChangesTemplate } from './builder.js';

/**
 * How a search narrows the catalogue: the scope families, and status for the health check, which
 * covers every service.
 */
export const CATEGORIES = ['templates', 'documents', 'workspaces', 'forms', 'pdf', 'einvoice', 'status'] as const;
export type OperationCategory = typeof CATEGORIES[number];

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;

/** The operations that need no scope, so have no scope family to name their category. */
const UNSCOPED_CATEGORIES: Record<string, OperationCategory> = {
  get_status: 'status',
  get_template_schema: 'templates',
  get_template_library: 'templates',
  get_template_library_item: 'templates',
  get_template_library_items: 'templates',
  get_form_schema: 'forms',
  get_einvoice_schema: 'einvoice',
};

/**
 * Words people use for an operation that its ID, title and description don't carry, so a search
 * in the user's words still finds it.
 */
const KEYWORDS: Record<string, string[]> = {
  optimize_document: ['compress', 'shrink', 'reduce', 'smaller'],
  encrypt_document: ['password', 'protect', 'lock', 'secure'],
  decrypt_document: ['password', 'unlock', 'remove'],
  make_accessible: ['ua', 'a11y', 'tagged'],
  create_facturx_einvoice: ['zugferd'],
  get_document_signatures: ['signed', 'verify'],
  promote_template_version: ['restore', 'revert', 'rollback', 'publish', 'live'],
  copy_template: ['duplicate', 'clone'],
  delete_template: ['remove'],
  delete_template_version: ['remove'],
  delete_document: ['remove'],
  delete_workspace: ['remove'],
  delete_form: ['remove'],
  generate_document: ['render', 'merge', 'create'],
  get_template_data: ['placeholders', 'fields', 'sample'],
  validate_template: ['check'],
  open_editor: ['edit', 'design'],
  get_builder_guide: ['build', 'layout', 'design'],
  run_builder_tool: ['component', 'page', 'row', 'column', 'table', 'add', 'move', 'patch', 'remove', 'change'],
  convert_url_to_pdf: ['website', 'webpage', 'web'],
  generate_qr_code: ['barcode'],
  store_document: ['upload', 'save'],
  generate_viewer_url: ['view', 'link', 'share'],
  share_form: ['link', 'public', 'collect'],
};

const ID_WEIGHT = 3;
const TITLE_WEIGHT = 3;
const KEYWORD_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;
const PLURAL_MATCH = 0.9;
const PARTIAL_MATCH = 0.7;
const MIN_PARTIAL_LENGTH = 3;
/** A result scoring under this share of the best one is noise, and is left out. */
const MIN_RELATIVE_SCORE = 0.25;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'i', 'in', 'into', 'is', 'it', 'its', 'me',
  'my', 'of', 'on', 'or', 'the', 'this', 'to', 'with',
]);

export interface Operation {
  id: string;
  category: OperationCategory;
  title: string;
  readOnly: boolean;
  /** Roughly how many tokens the operation's input schema takes, at four characters a token. */
  schemaTokens: number;
  definition: McpToolDefinition;
}

interface IndexedOperation {
  operation: Operation;
  fields: { words: Set<string>; weight: number }[];
}

export interface SearchOptions {
  category?: OperationCategory;
  limit?: number;
  /** The operations to search, all of them by default. */
  operations?: Operation[];
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 0);
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function categoryOf(id: string): OperationCategory {
  const scope = requiredScope(id);
  const category = scope === null ? UNSCOPED_CATEGORIES[id] : scope.split(':')[0];

  if (!CATEGORIES.includes(category as OperationCategory)) {
    throw new Error(`Operation "${id}" has no category`);
  }

  return category as OperationCategory;
}

function toOperation(definition: McpToolDefinition): Operation {
  const annotations = toolAnnotations[definition.name];

  if (!annotations) {
    throw new Error(`Operation "${definition.name}" has no annotations`);
  }

  return {
    id: definition.name,
    category: categoryOf(definition.name),
    title: annotations.title,
    readOnly: annotations.readOnlyHint === true,
    schemaTokens: estimateTokens(simplifySchemaForOpenAI(definition.inputSchema)),
    definition,
  };
}

export const operations: Map<string, Operation> = new Map(
  [...catalogue.values()].map(definition => [definition.name, toOperation(definition)]),
);

const index: Map<string, IndexedOperation> = new Map(
  [...operations.values()].map(operation => [operation.id, {
    operation,
    fields: [
      { words: new Set(words(operation.id)), weight: ID_WEIGHT },
      { words: new Set(words(operation.title)), weight: TITLE_WEIGHT },
      { words: new Set(KEYWORDS[operation.id] ?? []), weight: KEYWORD_WEIGHT },
      { words: new Set(words(operation.definition.description)), weight: DESCRIPTION_WEIGHT },
    ],
  }]),
);

/**
 * Whether one call only reads: an operation that only reads, or a builder tool run that only
 * reads the template.
 */
export function isReadOnlyCall(operation: Operation, args: Record<string, unknown> = {}): boolean {
  if (operation.id === RUN_BUILDER_TOOL) {
    return !builderToolChangesTemplate(args.tool);
  }

  return operation.readOnly;
}

/** 1 for the same word, less for a plural or a prefix, 0 for anything else. */
function wordMatch(term: string, word: string): number {
  if (term === word) {
    return 1;
  }

  const [shorter, longer] = term.length < word.length ? [term, word] : [word, term];

  if (shorter.length < MIN_PARTIAL_LENGTH || !longer.startsWith(shorter)) {
    return 0;
  }

  return longer === `${shorter}s` || longer === `${shorter}es` ? PLURAL_MATCH : PARTIAL_MATCH;
}

function termMatch(term: string, entry: IndexedOperation): number {
  let best = 0;

  for (const field of entry.fields) {
    for (const word of field.words) {
      best = Math.max(best, wordMatch(term, word) * field.weight);
    }
  }

  return best;
}

/**
 * The operations that best match a query, best first. A term counts most in the ID and the title,
 * less in the keywords and least in the description; a term most operations share counts less, and
 * an operation that matches every term ranks above one that matches some. A query of stop words
 * only lists the operations in catalogue order.
 */
export function searchOperations(query: string, options: SearchOptions = {}): Operation[] {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
  const candidates = (options.operations ?? [...operations.values()])
    .filter(operation => options.category === undefined || operation.category === options.category);
  const terms = [...new Set(words(query).filter(term => !STOP_WORDS.has(term)))];

  if (terms.length === 0) {
    return candidates.slice(0, limit);
  }

  const entries = candidates.map(operation => index.get(operation.id)!);
  const rarity = new Map(terms.map(term => {
    const sharing = entries.filter(entry => termMatch(term, entry) > 0).length;

    return [term, Math.log(1 + entries.length / Math.max(sharing, 1))];
  }));

  const results = entries
    .map((entry, position) => {
      const matches = terms.map(term => termMatch(term, entry) * rarity.get(term)!);
      const matched = matches.filter(score => score > 0).length;
      const score = matches.reduce((sum, value) => sum + value, 0) * (matched / terms.length);

      return { operation: entry.operation, score, idWords: entry.fields[0].words.size, position };
    })
    .filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.idWords - b.idWords || a.position - b.position);
  const best = results[0]?.score ?? 0;

  return results
    .filter(result => result.score >= best * MIN_RELATIVE_SCORE)
    .slice(0, limit)
    .map(result => result.operation);
}
