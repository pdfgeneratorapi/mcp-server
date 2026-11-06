/**
 * Type definition for JSON objects
 */
export type JsonObject = Record<string, any>;

/**
 * Interface for MCP Tool Definition
 */
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: any;
    method: string;
    pathTemplate: string;
    executionParameters: { name: string, in: string }[];
    requestBodyContentType?: string;
    /** Where pathTemplate is resolved; API_BASE_URL when absent. */
    baseUrl?: string;
    /** Shortens the JSON response, unless the call asks for the full response. */
    summarizeResponse?: (body: JsonObject) => JsonObject;
    /** Shows an image, or each image of a zip, as an image block instead of an embedded file. */
    imageResponse?: boolean;
    /**
     * Completes the validated request body before it is sent, or refuses the call by throwing
     * InvalidArgumentsError.
     */
    prepareRequestBody?: (body: JsonObject) => JsonObject;
}
