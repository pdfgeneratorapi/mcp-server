import { describe, it, expect } from '@jest/globals';
import {
  CATEGORIES,
  estimateTokens,
  rankOperations,
  searchLimit,
  isReadOnlyCall,
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

  it('takes the title and whether it only reads from the annotations', () => {
    expect(operation('get_templates')).toMatchObject({ title: 'List Templates', readOnly: true });
    expect(operation('preview_template')).toMatchObject({ title: 'Preview Template Pages', readOnly: true });
    expect(operation('delete_template')).toMatchObject({ title: 'Delete Template', readOnly: false });
    expect(operation('run_builder_tool').readOnly).toBe(false);
  });

  it('estimates tokens at four characters a token', () => {
    expect(estimateTokens({ a: 1 })).toBe(2);
    expect(estimateTokens({ type: 'object', properties: {} })).toBe(9);
  });

  it('costs each operation its whole input schema', () => {
    const addWatermark = operation('add_watermark');

    expect(addWatermark.schemaTokens).toBe(estimateTokens(addWatermark.definition.inputSchema));
    expect(operation('get_status').schemaTokens).toBe(9);
  });
});

describe('which calls only read', () => {
  it('follows the operation for anything but the builder', () => {
    expect(isReadOnlyCall(operation('get_template'), {})).toBe(true);
    expect(isReadOnlyCall(operation('update_template'), {})).toBe(false);
  });

  it.each([
    ['get_template_structure', true],
    ['list_components', true],
    ['validate_template', true],
    ['add_component', false],
    ['remove_page', false],
    ['a_tool_added_later', false],
    [undefined, false],
    [42, false],
  ])('counts a builder run of %s as a read: %s', (tool, readOnly) => {
    expect(isReadOnlyCall(operation('run_builder_tool'), { template_id: 1, tool })).toBe(readOnly);
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
    expect(searchOperations(query)[0]?.id).toBe(expected);
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
    expect(searchOperations(query)[0]?.id).toBe(expected);
  });

  it.each([
    ['edit template'],
    ['modify template'],
    ['rename template'],
  ])('finds the ways to change a template for "%s"', (query) => {
    expect(ids(searchOperations(query))).toEqual(expect.arrayContaining(['update_template', 'run_builder_tool']));
  });

  it('ranks an operation matching every term above those matching some', () => {
    expect(ids(searchOperations('delete template')).slice(0, 2)).toEqual(['delete_template', 'delete_template_version']);
  });

  it('matches a plural and a prefix', () => {
    expect(ids(searchOperations('watermarks'))).toEqual(['add_watermark']);
    expect(ids(searchOperations('waterm'))).toEqual(['add_watermark']);
  });

  it('ignores case and punctuation', () => {
    expect(ids(searchOperations('XRechnung!'))).toEqual(['create_xrechnung_einvoice']);
  });

  it('leaves out results far below the best one', () => {
    expect(ids(searchOperations('watermark'))).toEqual(['add_watermark']);
  });

  it('finds nothing for words no operation carries', () => {
    expect(searchOperations('spaceship')).toEqual([]);
  });

  it('searches one category only when given one', () => {
    expect(ids(searchOperations('delete', { category: 'forms' }))).toEqual(['delete_form']);
  });

  it('searches only the operations given', () => {
    expect(ids(searchOperations('template', { operations: [operation('get_templates'), operation('get_status')] })))
      .toEqual(['get_templates']);
  });

  it('lists operations in catalogue order for a query of stop words only', () => {
    expect(ids(searchOperations('the', { category: 'workspaces' })))
      .toEqual(['get_workspaces', 'create_workspace', 'get_workspace', 'delete_workspace']);
    expect(ids(searchOperations('', { category: 'workspaces' })))
      .toEqual(['get_workspaces', 'create_workspace', 'get_workspace', 'delete_workspace']);
  });

  it('ranks every match, for a search to say how many it left out', () => {
    expect(rankOperations('', { category: 'templates' })).toHaveLength(23);
    expect(ids(rankOperations('watermark'))).toEqual(['add_watermark']);
  });

  it('keeps the limit between 1 and 25, 10 when none is given', () => {
    expect([searchLimit(), searchLimit(3), searchLimit(100), searchLimit(0), searchLimit(2.7)]).toEqual([10, 3, 25, 1, 2]);
  });

  it('returns 10 results by default, and between 1 and 25 when asked', () => {
    expect(searchOperations('')).toHaveLength(10);
    expect(searchOperations('', { limit: 3 })).toHaveLength(3);
    expect(searchOperations('', { limit: 100 })).toHaveLength(25);
    expect(searchOperations('', { limit: 0 })).toHaveLength(1);
    expect(searchOperations('', { limit: 2.7 })).toHaveLength(2);
  });
});
