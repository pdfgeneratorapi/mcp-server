/**
 * The catalogue as operations, which a client finds with a search, reads up on and runs, instead
 * of loading one tool per operation.
 */
import type { McpToolDefinition } from './types.js';
import { catalogue } from './catalogue.js';
import { toolAnnotations } from './annotations.js';
import { requiredScope } from './auth/scopes.js';

/**
 * How a search narrows the catalogue: the scope families, and status for the health check, which
 * covers every service.
 */
export const CATEGORIES = ['templates', 'documents', 'workspaces', 'forms', 'pdf', 'einvoice', 'status'] as const;
export type OperationCategory = typeof CATEGORIES[number];

/** What an operation does, from least to most: it reads, it changes something, or it deletes. */
export const LEVELS = ['read', 'write', 'delete'] as const;
export type OperationLevel = typeof LEVELS[number];

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
 * Arguments of the generate operations people search by: display_mode, how a PDF viewer opens the
 * document, and testing, a free document with a preview stamp.
 */
const GENERATE_ARGUMENTS = ['display', 'zoom', 'thumbnails', 'bookmarks', 'fullscreen', 'testing'];

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
  update_template: ['edit', 'modify', 'rename', 'change'],
  delete_template: ['remove'],
  delete_template_version: ['remove'],
  delete_document: ['remove'],
  delete_workspace: ['remove'],
  delete_form: ['remove'],
  generate_document: ['render', 'merge', 'create', ...GENERATE_ARGUMENTS],
  generate_document_async: GENERATE_ARGUMENTS,
  generate_document_batch: GENERATE_ARGUMENTS,
  generate_document_batch_async: GENERATE_ARGUMENTS,
  get_template_data: ['placeholders', 'fields', 'sample'],
  validate_template: ['check'],
  open_editor: ['edit', 'design'],
  get_builder_guide: ['build', 'layout', 'design'],
  run_builder_tool: ['component', 'page', 'row', 'column', 'table', 'add', 'move', 'patch', 'remove', 'change', 'edit', 'modify', 'rename', 'restyle'],
  convert_url_to_pdf: ['website', 'webpage', 'web'],
  generate_qr_code: ['barcode'],
  store_document: ['upload', 'save'],
  generate_viewer_url: ['view', 'link', 'share'],
  share_form: ['link', 'public', 'collect'],
};

/**
 * Words an operation's description uses only to say what it does not do, left out of the search
 * so they don't lead to it: Factur-X can't be previewed with testing.
 */
const RULED_OUT: Record<string, string[]> = {
  create_facturx_einvoice: ['preview', 'mode', 'testing', 'true', 'available'],
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
  level: OperationLevel;
  definition: McpToolDefinition;
}

interface IndexedOperation {
  operation: Operation;
  fields: { words: Set<string>; weight: number }[];
}

export interface RankOptions {
  category?: OperationCategory;
  /** The operations to search, all of them by default. */
  operations?: Operation[];
}

export interface SearchOptions extends RankOptions {
  limit?: number;
}

export interface SearchResult {
  /** The best matches, as many as the limit allows. */
  found: Operation[];
  /** How many operations matched in all. */
  total: number;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 0);
}

/** Roughly how many tokens a value takes as JSON, at four characters a token. */
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
    level: annotations.readOnlyHint === true ? 'read' : annotations.destructiveHint === true ? 'delete' : 'write',
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
      {
        words: new Set(words(operation.definition.description).filter(word => !RULED_OUT[operation.id]?.includes(word))),
        weight: DESCRIPTION_WEIGHT,
      },
    ],
  }]),
);

/**
 * What one call does: the operation's level, or, for an operation whose arguments decide, a read
 * when the call only reads.
 */
export function callLevel(operation: Operation, args: Record<string, unknown> = {}): OperationLevel {
  const { readOnlyCall } = operation.definition;

  if (readOnlyCall) {
    return readOnlyCall(args) ? 'read' : operation.level;
  }

  return operation.level;
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

/** How many results a search returns: the limit asked for, within 1 and MAX_SEARCH_LIMIT. */
function searchLimit(limit?: number): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
}

/**
 * The best matches for a query, as many as the limit allows (10 when none is given, between 1
 * and MAX_SEARCH_LIMIT), and how many matched in all.
 */
export function searchOperations(query: string, options: SearchOptions = {}): SearchResult {
  const ranked = rankOperations(query, options);

  return { found: ranked.slice(0, searchLimit(options.limit)), total: ranked.length };
}

/**
 * Every operation that matches a query, best first. A term counts most in the ID and the title,
 * less in the keywords and least in the description; a term most operations share counts less, and
 * an operation that matches every term ranks above one that matches some. A query of stop words
 * only lists the operations in catalogue order.
 */
function rankOperations(query: string, options: RankOptions = {}): Operation[] {
  const candidates = (options.operations ?? [...operations.values()])
    .filter(operation => options.category === undefined || operation.category === options.category);
  const terms = [...new Set(words(query).filter(term => !STOP_WORDS.has(term)))];

  if (terms.length === 0) {
    return candidates;
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
    .map(result => result.operation);
}
