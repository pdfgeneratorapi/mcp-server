/**
 * Unit tests for simplifySchemaForOpenAI function
 */

import { simplifySchemaForOpenAI } from '../index.js';

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
});
