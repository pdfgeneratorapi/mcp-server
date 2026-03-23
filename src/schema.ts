/**
 * Simplifies JSON Schema for OpenAI function calling compatibility
 * OpenAI has strict requirements:
 * - No oneOf, anyOf, allOf
 * - required must include ALL properties or be omitted
 */
export function simplifySchemaForOpenAI(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;

    let simplified = { ...schema };

    // Handle allOf - merge all schemas
    if (simplified.allOf && Array.isArray(simplified.allOf)) {
        const merged: any = { type: 'object', properties: {} };
        for (const subSchema of simplified.allOf) {
            const simplifiedSub = simplifySchemaForOpenAI(subSchema);
            if (simplifiedSub.properties) {
                merged.properties = { ...merged.properties, ...simplifiedSub.properties };
            }
        }
        delete simplified.allOf;
        simplified = { ...simplified, ...merged };
    }

    // Handle oneOf/anyOf - use the first option
    if (simplified.oneOf && Array.isArray(simplified.oneOf)) {
        const firstOption = simplifySchemaForOpenAI(simplified.oneOf[0]);
        const description = simplified.description || '';
        delete simplified.oneOf;
        simplified = {
            ...simplified,
            ...firstOption,
            description: description ? description + ' (Multiple input formats supported)' : undefined
        };
        if (!simplified.description) delete simplified.description;
    }

    if (simplified.anyOf && Array.isArray(simplified.anyOf)) {
        const firstOption = simplifySchemaForOpenAI(simplified.anyOf[0]);
        const description = simplified.description || '';
        delete simplified.anyOf;
        simplified = {
            ...simplified,
            ...firstOption,
            description: description ? description + ' (Multiple formats supported)' : undefined
        };
        if (!simplified.description) delete simplified.description;
    }

    // Ensure type exists
    if (!simplified.type && simplified.properties) {
        simplified.type = 'object';
    }

    // Recursively simplify properties
    if (simplified.properties) {
        simplified.properties = Object.fromEntries(
            Object.entries(simplified.properties).map(([key, value]) => [
                key,
                simplifySchemaForOpenAI(value)
            ])
        );

        // OpenAI requires 'required' to include ALL properties or be omitted
        // We'll remove 'required' to make all properties optional
        delete simplified.required;
    }

    // Recursively simplify items
    if (simplified.items) {
        simplified.items = simplifySchemaForOpenAI(simplified.items);
    }

    // Remove unsupported keywords
    delete simplified.$ref;
    delete simplified.$schema;
    delete simplified.additionalProperties;
    delete simplified.patternProperties;
    delete simplified.if;
    delete simplified.then;
    delete simplified.else;
    delete simplified.not;
    delete simplified.format; // OpenAI doesn't like custom formats

    return simplified;
}
