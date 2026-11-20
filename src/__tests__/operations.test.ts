import { describe, it, expect } from '@jest/globals';
import {
  CATEGORIES,
  estimateTokens,
  callLevel,
  operations,
  searchOperations,
  type Operation,
} from '../operations.js';
import { catalogue } from '../catalogue.js';

const operation = (id: string): Operation => {
  const found = operations.get(id);

  if (!found) {
    throw new Error(`No operation "${id}"`);
  }

  return found;
};

const ids = (found: Operation[]) => found.map(item => item.id);
const search = (...args: Parameters<typeof searchOperations>) => searchOperations(...args).found;

describe('the operation index', () => {
  it('has one operation for each catalogue entry, each with a category and a title', () => {
    expect([...operations.keys()]).toEqual([...catalogue.keys()]);

    for (const item of operations.values()) {
      expect(CATEGORIES).toContain(item.category);
      expect(item.title).not.toBe('');
      expect(item.definition).toBe(catalogue.get(item.id));
    }
  });

  it.each([
    ['get_templates', 'templates'],
    ['run_builder_tool', 'templates'],
    ['measure_text', 'templates'],
    ['preview_template', 'documents'],
    ['generate_document', 'documents'],
    ['delete_workspace', 'workspaces'],
    ['share_form', 'forms'],
    ['convert_html_to_pdf', 'pdf'],
    ['show_pdf_pages', 'pdf'],
    ['create_xrechnung_einvoice', 'einvoice'],
  ])('puts %s, which needs a scope, in its scope family: %s', (id, category) => {
    expect(operation(id).category).toBe(category);
  });

  it('keeps the status category for the health check alone', () => {
    expect(ids([...operations.values()].filter(item => item.category === 'status'))).toEqual(['get_status']);
  });

  it.each([
    ['get_status', 'status'],
    ['get_template_schema', 'templates'],
    ['get_template_library_items', 'templates'],
    ['get_form_schema', 'forms'],
    ['get_einvoice_schema', 'einvoice'],
  ])('puts %s, which needs no scope, in %s', (id, category) => {
    expect(operation(id).category).toBe(category);
  });

  it('takes the title and the level from the annotations: read-only, destructive, or neither', () => {
    expect(operation('get_templates')).toMatchObject({ title: 'List Templates', level: 'read' });
    expect(operation('preview_template')).toMatchObject({ title: 'Preview Template Pages', level: 'read' });
    expect(operation('generate_document')).toMatchObject({ title: 'Generate PDF Document', level: 'write' });
    expect(operation('delete_template')).toMatchObject({ title: 'Delete Template', level: 'delete' });
    expect(operation('run_builder_tool').level).toBe('write');
  });

  it('estimates tokens at four characters a token', () => {
    expect(estimateTokens({ a: 1 })).toBe(2);
    expect(estimateTokens({ type: 'object', properties: {} })).toBe(9);
  });
});

describe('what one call does', () => {
  it('is the operation\'s level, for an operation whose arguments do not decide it', () => {
    expect(callLevel(operation('get_template'), {})).toBe('read');
    expect(callLevel(operation('update_template'), {})).toBe('write');
    expect(callLevel(operation('delete_workspace'), {})).toBe('delete');
  });

  it.each([
    ['get_template_structure', 'read'],
    ['list_components', 'read'],
    ['validate_template', 'read'],
    ['add_component', 'write'],
    ['remove_page', 'write'],
    ['a_tool_added_later', 'write'],
    [undefined, 'write'],
    [42, 'write'],
  ])('is a read for a builder run of %s only when the builder tool only reads: %s', (tool, level) => {
    expect(callLevel(operation('run_builder_tool'), { template_id: 1, tool })).toBe(level);
  });
});

describe('searchOperations', () => {
  it.each([
    ['watermark', 'add_watermark'],
    ['html pdf', 'convert_html_to_pdf'],
    ['delete template', 'delete_template'],
    ['list templates', 'get_templates'],
    ['generate pdf from template', 'generate_document'],
    ['async job', 'get_async_job_status'],
    ['xrechnung', 'create_xrechnung_einvoice'],
    ['qr code', 'generate_qr_code'],
    ['preview template', 'preview_template'],
    ['build template', 'get_builder_guide'],
    ['add component', 'run_builder_tool'],
    ['fonts', 'list_fonts'],
    ['share form', 'share_form'],
    ['signature', 'get_document_signatures'],
    ['template versions', 'list_template_versions'],
    ['pdf to image', 'convert_pdf_to_image'],
    ['template schema', 'get_template_schema'],
    ['measure text', 'measure_text'],
    ['edit template in editor', 'open_editor'],
  ])('ranks "%s" first at %s', (query, expected) => {
    expect(search(query)[0]?.id).toBe(expected);
  });

  it.each([
    ['compress pdf', 'optimize_document'],
    ['password protect pdf', 'encrypt_document'],
    ['zugferd', 'create_facturx_einvoice'],
    ['restore template version', 'promote_template_version'],
    ['duplicate template', 'copy_template'],
    ['remove template', 'delete_template'],
    ['website to pdf', 'convert_url_to_pdf'],
  ])('finds "%s" by a word only its keywords carry: %s', (query, expected) => {
    expect(search(query)[0]?.id).toBe(expected);
  });

  it.each([
    ['edit template'],
    ['modify template'],
    ['rename template'],
  ])('finds the ways to change a template for "%s"', (query) => {
    expect(ids(search(query))).toEqual(expect.arrayContaining(['update_template', 'run_builder_tool']));
  });

  it.each([['zoom'], ['initial zoom'], ['thumbnails'], ['bookmarks panel'], ['fullscreen']])(
    'finds the generate operations, which say how a PDF viewer opens the document, for "%s"',
    (query) => {
      expect(ids(search(query))[0]).toBe('generate_document');
    },
  );

  it('keeps a text outline with the text operations, not with how a PDF viewer opens', () => {
    expect(ids(search('outline'))[0]).toBe('measure_text');
  });

  it('finds no operation by what its description says it cannot do', () => {
    expect(ids(search('preview'))).toEqual(['preview_template', 'show_pdf_pages']);
  });

  it('ranks an operation matching every term above those matching some', () => {
    expect(ids(search('delete template')).slice(0, 2)).toEqual(['delete_template', 'delete_template_version']);
  });

  it('matches a plural and a prefix', () => {
    expect(ids(search('watermarks'))).toEqual(['add_watermark']);
    expect(ids(search('waterm'))).toEqual(['add_watermark']);
  });

  it('ignores case and punctuation', () => {
    expect(ids(search('XRechnung!'))).toEqual(['create_xrechnung_einvoice', 'create_einvoice']);
  });

  it('leaves out results far below the best one', () => {
    expect(ids(search('watermark'))).toEqual(['add_watermark']);
  });

  it('finds nothing for words no operation carries', () => {
    expect(search('spaceship')).toEqual([]);
  });

  it('searches one category only when given one', () => {
    expect(ids(search('delete', { category: 'forms' }))).toEqual(['delete_form']);
  });

  it('searches only the operations given', () => {
    expect(ids(search('template', { operations: [operation('get_templates'), operation('get_status')] })))
      .toEqual(['get_templates']);
  });

  it('lists operations in catalogue order for a query of stop words only', () => {
    expect(ids(search('the', { category: 'workspaces' })))
      .toEqual(['get_workspaces', 'create_workspace', 'get_workspace', 'delete_workspace']);
    expect(ids(search('', { category: 'workspaces' })))
      .toEqual(['get_workspaces', 'create_workspace', 'get_workspace', 'delete_workspace']);
  });

  it('says how many operations matched in all, beyond the limit', () => {
    expect(searchOperations('', { category: 'templates' })).toEqual({ found: expect.any(Array), total: 23 });
    expect(searchOperations('', { category: 'templates' }).found).toHaveLength(10);
    expect(searchOperations('watermark')).toEqual({ found: [operation('add_watermark')], total: 1 });
  });

  it('returns 10 results by default, and between 1 and 25 when asked', () => {
    expect(search('')).toHaveLength(10);
    expect(search('', { limit: 3 })).toHaveLength(3);
    expect(search('', { limit: 100 })).toHaveLength(25);
    expect(search('', { limit: 0 })).toHaveLength(1);
    expect(search('', { limit: 2.7 })).toHaveLength(2);
  });
});
