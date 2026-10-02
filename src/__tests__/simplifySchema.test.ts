/**
 * Unit tests for simplifySchemaForOpenAI function
 */

import { simplifySchemaForOpenAI } from '../index.js';
import { toolDefinitionMap } from '../tools.js';

describe('simplifySchemaForOpenAI', () => {
  describe('basic input handling', () => {
    it('should return null/undefined as-is', () => {
      expect(simplifySchemaForOpenAI(null)).toBeNull();
      expect(simplifySchemaForOpenAI(undefined)).toBeUndefined();
    });

    it('should return primitives as-is', () => {
      expect(simplifySchemaForOpenAI('string')).toBe('string');
      expect(simplifySchemaForOpenAI(123)).toBe(123);
      expect(simplifySchemaForOpenAI(true)).toBe(true);
    });

    it('should handle empty object', () => {
      const result = simplifySchemaForOpenAI({});
      expect(result).toEqual({});
    });

    it('should preserve basic schema properties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('object');
      expect(result.properties.name.type).toBe('string');
      expect(result.properties.age.type).toBe('number');
    });
  });

  describe('allOf handling', () => {
    it('should merge allOf schemas into single object', () => {
      const schema = {
        allOf: [
          { properties: { name: { type: 'string' } } },
          { properties: { age: { type: 'number' } } }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('object');
      expect(result.properties.name.type).toBe('string');
      expect(result.properties.age.type).toBe('number');
      expect(result.allOf).toBeUndefined();
    });

    it('should handle allOf with nested properties', () => {
      const schema = {
        allOf: [
          {
            properties: {
              address: {
                type: 'object',
                properties: { city: { type: 'string' } }
              }
            }
          }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.properties.address.type).toBe('object');
      expect(result.properties.address.properties.city.type).toBe('string');
    });
  });

  describe('oneOf handling', () => {
    it('should use first option from oneOf', () => {
      const schema = {
        oneOf: [
          { type: 'string' },
          { type: 'number' }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('string');
      expect(result.oneOf).toBeUndefined();
    });

    it('should preserve description and add note about multiple formats', () => {
      const schema = {
        description: 'Input value',
        oneOf: [
          { type: 'string' },
          { type: 'number' }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.description).toContain('Input value');
      expect(result.description).toContain('Multiple input formats supported');
    });

    it('should not add empty description', () => {
      const schema = {
        oneOf: [{ type: 'string' }]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.description).toBeUndefined();
    });
  });

  describe('anyOf handling', () => {
    it('should use first option from anyOf', () => {
      const schema = {
        anyOf: [
          { type: 'boolean' },
          { type: 'string' }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('boolean');
      expect(result.anyOf).toBeUndefined();
    });

    it('should preserve description with multiple formats note', () => {
      const schema = {
        description: 'Flag value',
        anyOf: [
          { type: 'boolean' },
          { type: 'number' }
        ]
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.description).toContain('Flag value');
      expect(result.description).toContain('Multiple formats supported');
    });
  });

  describe('type inference', () => {
    it('should add type object if properties exist but type is missing', () => {
      const schema = {
        properties: {
          name: { type: 'string' }
        }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('object');
    });

    it('should not override existing type', () => {
      const schema = {
        type: 'array',
        properties: {
          name: { type: 'string' }
        }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.type).toBe('array');
    });
  });

  describe('required field removal', () => {
    it('should remove required array from schema', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' }
        },
        required: ['name', 'email']
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.required).toBeUndefined();
    });
  });

  describe('items handling', () => {
    it('should recursively simplify array items', () => {
      const schema = {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            { type: 'number' }
          ]
        }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.items.type).toBe('string');
      expect(result.items.oneOf).toBeUndefined();
    });
  });

  describe('unsupported keyword removal', () => {
    it('should remove $ref', () => {
      const schema = {
        $ref: '#/definitions/SomeType',
        type: 'object'
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.$ref).toBeUndefined();
    });

    it('should remove $schema', () => {
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object'
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.$schema).toBeUndefined();
    });

    it('should remove additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: false
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.additionalProperties).toBeUndefined();
    });

    it('should remove patternProperties', () => {
      const schema = {
        type: 'object',
        patternProperties: { '^S_': { type: 'string' } }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.patternProperties).toBeUndefined();
    });

    it('should remove conditional keywords (if/then/else)', () => {
      const schema = {
        type: 'object',
        if: { properties: { type: { const: 'A' } } },
        then: { properties: { a: { type: 'string' } } },
        else: { properties: { b: { type: 'number' } } }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.if).toBeUndefined();
      expect(result.then).toBeUndefined();
      expect(result.else).toBeUndefined();
    });

    it('should remove not keyword', () => {
      const schema = {
        type: 'string',
        not: { enum: ['invalid'] }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.not).toBeUndefined();
    });

    it('should remove format keyword', () => {
      const schema = {
        type: 'string',
        format: 'email'
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.format).toBeUndefined();
    });
  });

  describe('recursive simplification', () => {
    it('should simplify deeply nested properties', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              profile: {
                oneOf: [
                  { type: 'object', properties: { name: { type: 'string' } } },
                  { type: 'null' }
                ]
              }
            },
            required: ['profile']
          }
        },
        required: ['user']
      };
      const result = simplifySchemaForOpenAI(schema);

      expect(result.required).toBeUndefined();
      expect(result.properties.user.required).toBeUndefined();
      expect(result.properties.user.properties.profile.oneOf).toBeUndefined();
      expect(result.properties.user.properties.profile.type).toBe('object');
    });
  });

  describe('real-world schema examples', () => {
    it('should handle PDF Generator API watermark schema', () => {
      const schema = {
        type: 'object',
        properties: {
          requestBody: {
            oneOf: [
              {
                type: 'object',
                required: ['file_url', 'watermark'],
                properties: {
                  file_url: { type: 'string', format: 'url' },
                  watermark: {
                    type: 'object',
                    properties: {
                      text: {
                        type: 'object',
                        required: ['content'],
                        properties: {
                          content: { type: 'string' },
                          color: { type: 'string', default: '#000000' }
                        }
                      }
                    }
                  }
                }
              },
              {
                type: 'object',
                required: ['file_base64', 'watermark'],
                properties: {
                  file_base64: { type: 'string' }
                }
              }
            ]
          }
        },
        required: ['requestBody']
      };

      const result = simplifySchemaForOpenAI(schema);

      // Top level required removed
      expect(result.required).toBeUndefined();

      // oneOf resolved to first option
      expect(result.properties.requestBody.oneOf).toBeUndefined();
      expect(result.properties.requestBody.type).toBe('object');

      // format removed
      expect(result.properties.requestBody.properties.file_url.format).toBeUndefined();

      // nested required removed
      expect(result.properties.requestBody.required).toBeUndefined();
      expect(result.properties.requestBody.properties.watermark.properties.text.required).toBeUndefined();
    });
  });

  describe('enum sanitization', () => {
    it('removes empty-string values from a string enum', () => {
      const result = simplifySchemaForOpenAI({
        type: 'string',
        enum: ['private', 'organization', '']
      });
      expect(result.enum).toEqual(['private', 'organization']);
    });

    it('drops a default that is no longer a valid enum member', () => {
      const result = simplifySchemaForOpenAI({
        type: 'string',
        enum: ['private', 'organization', ''],
        default: ''
      });
      expect(result.enum).toEqual(['private', 'organization']);
      expect('default' in result).toBe(false);
    });

    it('keeps a default that is still a valid enum member', () => {
      const result = simplifySchemaForOpenAI({
        type: 'string',
        enum: ['private', 'organization', ''],
        default: 'private'
      });
      expect(result.enum).toEqual(['private', 'organization']);
      expect(result.default).toBe('private');
    });

    it('removes the enum entirely when it becomes empty', () => {
      const result = simplifySchemaForOpenAI({
        type: 'string',
        enum: [''],
        default: ''
      });
      expect('enum' in result).toBe(false);
      expect('default' in result).toBe(false);
      expect(result.type).toBe('string');
    });

    it('sanitizes enums nested under properties', () => {
      const result = simplifySchemaForOpenAI({
        type: 'object',
        properties: {
          access: {
            type: 'string',
            enum: ['private', 'organization', ''],
            default: ''
          }
        }
      });
      expect(result.properties.access.enum).toEqual(['private', 'organization']);
      expect('default' in result.properties.access).toBe(false);
    });

    it('sanitizes enums nested under array items', () => {
      const result = simplifySchemaForOpenAI({
        type: 'array',
        items: {
          type: 'string',
          enum: ['a', 'b', '']
        }
      });
      expect(result.items.enum).toEqual(['a', 'b']);
    });

    it('leaves enums without empty strings unchanged', () => {
      const result = simplifySchemaForOpenAI({
        type: 'string',
        enum: ['private', 'organization']
      });
      expect(result.enum).toEqual(['private', 'organization']);
    });

    it('handles the real-world get_templates access schema', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filter template by name' },
          tags: { type: 'string', description: 'Filter template by tags' },
          access: {
            type: 'string',
            enum: ['private', 'organization', ''],
            default: '',
            description: 'Filter template by access type. No values returns all templates.'
          },
          page: { type: 'number', default: 1 },
          per_page: { type: 'number', default: 15 }
        }
      };
      const result = simplifySchemaForOpenAI(schema);
      expect(result.properties.access.enum).toEqual(['private', 'organization']);
      expect('default' in result.properties.access).toBe(false);
      // Numeric defaults on unrelated fields must be untouched.
      expect(result.properties.page.default).toBe(1);
      expect(result.properties.per_page.default).toBe(15);
    });
  });
});

describe('tool schemas are Gemini-compatible (no empty-string enums)', () => {
  // Recursively collect every `enum` array reachable from a schema node.
  function collectEnums(node: any, enums: any[][] = []): any[][] {
    if (!node || typeof node !== 'object') return enums;
    if (Array.isArray(node)) {
      for (const item of node) collectEnums(item, enums);
      return enums;
    }
    if (Array.isArray(node.enum)) enums.push(node.enum);
    for (const value of Object.values(node)) collectEnums(value, enums);
    return enums;
  }

  // Mirrors Gemini's assertNoEmptyStringEnums check across every tool's
  // client-facing schema, so a future spec regeneration can't reintroduce the bug.
  it('no sanitized tool schema contains an empty-string enum value', () => {
    const offenders: string[] = [];
    for (const [name, def] of toolDefinitionMap) {
      const sanitized = simplifySchemaForOpenAI(def.inputSchema);
      for (const enumValues of collectEnums(sanitized)) {
        if (enumValues.includes('')) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Clients that map tool schemas onto a single-type dialect (Gemini function declarations,
 * the OpenAPI 3.0 subset) refuse or mishandle a type array such as ["object", "null"].
 */
describe('nullable type arrays', () => {
  it('serves a nullable object as an object, keeping its properties', () => {
    const result = simplifySchemaForOpenAI({
      description: 'Defines page size if layout is repeated on the page',
      type: ['object', 'null'],
      properties: { width: { type: 'number' } },
    });

    expect(result).toEqual({
      description: 'Defines page size if layout is repeated on the page',
      type: 'object',
      properties: { width: { type: 'number' } },
    });
  });

  it('serves a nullable string as a string', () => {
    expect(simplifySchemaForOpenAI({ type: ['string', 'null'] })).toEqual({ type: 'string' });
  });

  it('keeps the first type of a union, as it keeps the first branch of an anyOf', () => {
    expect(simplifySchemaForOpenAI({ type: ['string', 'number', 'null'] })).toEqual({ type: 'string' });
  });

  it('serves a field that can only be null as null', () => {
    expect(simplifySchemaForOpenAI({ type: ['null'] })).toEqual({ type: 'null' });
  });

  it('reaches nullable fields inside properties and array items', () => {
    const result = simplifySchemaForOpenAI({
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              layout: { type: ['object', 'null'] },
              backgroundImage: { type: ['string', 'null'] },
            },
          },
        },
      },
    });

    expect(result.properties.pages.items.properties.layout.type).toBe('object');
    expect(result.properties.pages.items.properties.backgroundImage.type).toBe('string');
  });
});

describe('tool schemas use one type per field', () => {
  function collectTypeArrays(node: any, path: string, found: string[]): string[] {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      node.forEach((item, index) => collectTypeArrays(item, `${path}[${index}]`, found));
      return found;
    }
    if (Array.isArray(node.type)) found.push(path);
    for (const [key, value] of Object.entries(node)) collectTypeArrays(value, `${path}.${key}`, found);
    return found;
  }

  it('no sanitized tool schema contains a type array', () => {
    const offenders: string[] = [];
    for (const [name, def] of toolDefinitionMap) {
      collectTypeArrays(simplifySchemaForOpenAI(def.inputSchema), name, offenders);
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Keeping only the first shape of a union hid the others from clients: a form could only store its
 * document, and a PDF tool only took a URL.
 */
describe('unions of objects', () => {
  it('serves a union of objects as one object with every option', () => {
    const result = simplifySchemaForOpenAI({
      anyOf: [
        { type: 'object', description: 'One action.', properties: { store_document: { type: 'boolean' } } },
        { type: 'object', properties: { send_document: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } },
      ],
    });

    expect(result.anyOf).toBeUndefined();
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties)).toEqual(['store_document', 'send_document']);
    expect(result.properties.send_document.properties.url.type).toBe('string');
    expect(result.properties.store_document.description).toBe('One action.');
  });

  it('keeps the first definition of a property two options share', () => {
    const result = simplifySchemaForOpenAI({
      oneOf: [
        { type: 'object', properties: { file_url: { type: 'string' }, name: { type: 'string', description: 'first' } } },
        { type: 'object', properties: { file_base64: { type: 'string' }, name: { type: 'string', description: 'second' } } },
      ],
    });

    expect(Object.keys(result.properties)).toEqual(['file_url', 'name', 'file_base64']);
    expect(result.properties.name.description).toBe('first');
  });

  /**
   * A form action's meaning lives on its option ("Posts the submitted answers as JSON…"), so merging
   * the options must not leave it behind.
   */
  it('moves each option\'s description onto the one property it introduces', () => {
    const result = simplifySchemaForOpenAI({
      anyOf: [
        { type: 'object', description: 'Stores it.', properties: { store_document: { type: 'boolean' } } },
        { type: 'object', description: 'Posts the answers.', properties: { send_document: { type: 'object', properties: { url: { type: 'string' } } } } },
      ],
    });

    expect(result.properties.store_document.description).toBe('Stores it.');
    expect(result.properties.send_document.description).toBe('Posts the answers.');
  });

  it('never replaces a property\'s own description, nor spreads one over several properties', () => {
    const result = simplifySchemaForOpenAI({
      oneOf: [
        { type: 'object', description: 'By URL.', properties: { file_url: { type: 'string' }, name: { type: 'string' } } },
        { type: 'object', description: 'By content.', properties: { file_base64: { type: 'string', description: 'Base64 content' }, name: { type: 'string' } } },
      ],
    });

    expect(result.properties.file_url.description).toBeUndefined();
    expect(result.properties.name.description).toBeUndefined();
    expect(result.properties.file_base64.description).toBe('Base64 content');
  });

  it('does not label the merged object with a description that moved onto its property', () => {
    const result = simplifySchemaForOpenAI({
      anyOf: [
        { type: 'object', description: 'Stores it.', properties: { store_document: { type: 'boolean' } } },
        { type: 'object', description: 'Posts the answers.', properties: { send_document: { type: 'object' } } },
      ],
    });

    expect(result.description).not.toContain('Stores it.');
  });

  it('tells clients what storing and downloading the document do', () => {
    const served = simplifySchemaForOpenAI(toolDefinitionMap.get('create_form')!.inputSchema);
    const actions = served.properties.requestBody.properties.actions.items;

    expect(actions.properties.store_document.description).toBe('Saves the generated document to Document Storage.');
    expect(actions.properties.download_document.description).toBe('Lets the person who fills in the form download the generated document.');
    expect(actions.description).not.toContain('Key-value pair of action configuration.');
  });

  it('tells clients that the send action posts the answers', () => {
    const served = simplifySchemaForOpenAI(toolDefinitionMap.get('create_form')!.inputSchema);
    const send = served.properties.requestBody.properties.actions.items.properties.send_document;

    expect(send.description).toMatch(/^Posts the submitted answers as JSON/);
    expect(send.properties.url.description).toMatch(/receives the submitted answers as JSON/);
  });

  it.each(['create_form', 'update_form'])('lets %s describe every form action', (toolName) => {
    const served = simplifySchemaForOpenAI(toolDefinitionMap.get(toolName)!.inputSchema);

    expect(Object.keys(served.properties.requestBody.properties.actions.items.properties)).toEqual([
      'store_document', 'download_document', 'send_document', 'sign_document',
    ]);
  });

  it('lets import_form describe every form action', () => {
    const served = simplifySchemaForOpenAI(toolDefinitionMap.get('import_form')!.inputSchema);

    expect(Object.keys(served.properties.requestBody.properties.form.properties.actions.items.properties)).toEqual([
      'store_document', 'download_document', 'send_document', 'sign_document',
    ]);
  });
});

