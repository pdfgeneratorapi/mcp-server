import { z, ZodError } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolDefinition, JsonObject } from './types.js';
import { API_BASE_URL } from './config.js';
import { log } from './logger.js';

/**
 * How a tool call obtains the credential for the API. It is asked only once the
 * arguments are valid, and told when the API rejected the credential.
 */
export interface UpstreamAuth {
    getToken(): Promise<string>;
    invalidate(): void;
}

const HTTP_UNAUTHORIZED = 401;

// Headers a tool argument must never set: tools.ts is generated from the OpenAPI
// document, so a header parameter could otherwise override credentials or routing.
const FORBIDDEN_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'forwarded',
]);
const FORBIDDEN_HEADER_PREFIXES = ['x-forwarded-'];

function isForbiddenHeader(name: string): boolean {
    const header = name.toLowerCase();
    return FORBIDDEN_HEADERS.has(header) || FORBIDDEN_HEADER_PREFIXES.some(prefix => header.startsWith(prefix));
}

/**
 * Executes an API tool with the provided arguments
 *
 * @param toolName Name of the tool to execute
 * @param definition Tool definition
 * @param toolArgs Arguments provided by the user
 * @param upstreamAuth Credentials for the API; without it the request is unauthenticated
 * @returns Call tool result
 */
export async function executeApiTool(
    toolName: string,
    definition: McpToolDefinition,
    toolArgs: JsonObject,
    upstreamAuth?: UpstreamAuth
): Promise<CallToolResult> {
  try {
    // Validate arguments against the input schema
    let validatedArgs: JsonObject;
    try {
        const zodSchema = getZodSchemaFromJsonSchema(definition.inputSchema, toolName);
        const argsToParse = (typeof toolArgs === 'object' && toolArgs !== null) ? toolArgs : {};
        validatedArgs = zodSchema.parse(argsToParse);
    } catch (error: unknown) {
        if (error instanceof ZodError) {
            const validationErrorMessage = `Invalid arguments for tool '${toolName}': ${error.errors.map(e => `${e.path.join('.')} (${e.code}): ${e.message}`).join(', ')}`;
            return { content: [{ type: 'text', text: validationErrorMessage }], isError: true };
        } else {
             const errorMessage = error instanceof Error ? error.message : String(error);
             return { content: [{ type: 'text', text: `Internal error during validation setup: ${errorMessage}` }], isError: true };
        }
    }

    // Prepare URL, query parameters, headers, and request body
    let urlPath = definition.pathTemplate;
    const queryParams: Record<string, any> = {};
    const headers: Record<string, string> = { 'Accept': 'application/json' };
    let requestBodyData: any = undefined;

    // Apply parameters to the URL path, query, or headers
    definition.executionParameters.forEach((param) => {
        const value = validatedArgs[param.name];
        if (typeof value !== 'undefined' && value !== null) {
            if (param.in === 'path') {
                urlPath = urlPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
            }
            else if (param.in === 'query') {
                queryParams[param.name] = value;
            }
            else if (param.in === 'header') {
                if (isForbiddenHeader(param.name)) {
                    log.warn(`Ignoring tool argument for protected header '${param.name}' in tool '${toolName}'`);
                } else {
                    headers[param.name.toLowerCase()] = String(value);
                }
            }
        }
    });

    // Ensure all path parameters are resolved
    if (urlPath.includes('{')) {
        throw new Error(`Failed to resolve path parameters: ${urlPath}`);
    }
    
    // Construct the full URL
    const requestUrl = API_BASE_URL ? `${API_BASE_URL}${urlPath}` : urlPath;

    // Handle request body if needed
    if (definition.requestBodyContentType && typeof validatedArgs['requestBody'] !== 'undefined') {
        requestBodyData = validatedArgs['requestBody'];
        headers['content-type'] = definition.requestBodyContentType;
    }


    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(),
      url: requestUrl,
      params: queryParams,
      headers: headers,
      timeout: 30000,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    log.debug(`Executing tool "${toolName}": ${config.method} ${config.url}`);
    
    // Execute the request, renewing a rejected credential exactly once
    let response;
    try {
        response = await axios(await authenticated(config, upstreamAuth));
    } catch (error: unknown) {
        if (!upstreamAuth || !axios.isAxiosError(error) || error.response?.status !== HTTP_UNAUTHORIZED) {
            throw error;
        }

        upstreamAuth.invalidate();
        response = await axios(await authenticated(config, upstreamAuth));
    }

    // Process and format the response
    let responseText = '';
    const contentType = response.headers['content-type']?.toLowerCase() || '';
    
    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
         try { 
             responseText = JSON.stringify(response.data, null, 2); 
         } catch {
             responseText = "[Stringify Error]";
         }
    } 
    // Handle string responses
    else if (typeof response.data === 'string') { 
         responseText = response.data; 
    }
    // Handle other response types
    else if (response.data !== undefined && response.data !== null) { 
         responseText = String(response.data); 
    }
    // Handle empty responses
    else { 
         responseText = `(Status: ${response.status} - No body content)`; 
    }
    
    // Return formatted response
    return { 
        content: [ 
            { 
                type: "text", 
                text: `API Response (Status: ${response.status}):\n${responseText}` 
            } 
        ], 
    };

  } catch (error: unknown) {
    // Handle errors during execution
    let errorMessage: string;
    
    // Format Axios errors specially
    if (axios.isAxiosError(error)) { 
        errorMessage = formatApiError(error); 
    }
    // Handle standard errors
    else if (error instanceof Error) { 
        errorMessage = error.message; 
    }
    // Handle unexpected error types
    else { 
        errorMessage = 'Unexpected error: ' + String(error); 
    }
    
    log.error(`Error during execution of tool '${toolName}':`, errorMessage);
    
    // Return error message to client
    return { content: [{ type: "text", text: errorMessage }], isError: true };
  }
}




/**
 * Returns the request with the API credential, fetched at the last moment.
 */
async function authenticated(config: AxiosRequestConfig, upstreamAuth?: UpstreamAuth): Promise<AxiosRequestConfig> {
    if (!upstreamAuth) {
        return config;
    }

    return { ...config, headers: { ...config.headers, authorization: `Bearer ${await upstreamAuth.getToken()}` } };
}

/**
 * Formats API errors for better readability
 * 
 * @param error Axios error
 * @returns Formatted error message
 */
function formatApiError(error: AxiosError): string {
    let message = 'API request failed.';
    if (error.response) {
        message = `API Error: Status ${error.response.status} (${error.response.statusText || 'Status text not available'}). `;
        const responseData = error.response.data;
        const MAX_LEN = 200;
        if (typeof responseData === 'string') { 
            message += `Response: ${responseData.substring(0, MAX_LEN)}${responseData.length > MAX_LEN ? '...' : ''}`; 
        }
        else if (responseData) { 
            try { 
                const jsonString = JSON.stringify(responseData); 
                message += `Response: ${jsonString.substring(0, MAX_LEN)}${jsonString.length > MAX_LEN ? '...' : ''}`; 
            } catch { 
                message += 'Response: [Could not serialize data]'; 
            } 
        }
        else { 
            message += 'No response body received.'; 
        }
    } else if (error.request) {
        message = 'API Network Error: No response received from server.';
        if (error.code) message += ` (Code: ${error.code})`;
    } else { 
        message += `API Request Setup Error: ${error.message}`; 
    }
    return message;
}

/**
 * Converts a JSON Schema to a Zod schema for runtime validation
 * 
 * @param jsonSchema JSON Schema
 * @param toolName Tool name for error reporting
 * @returns Zod schema
 */
function getZodSchemaFromJsonSchema(jsonSchema: any, toolName: string): z.ZodTypeAny {
    if (typeof jsonSchema !== 'object' || jsonSchema === null) { 
        return z.object({}).passthrough(); 
    }
    try {
        const zodSchemaString = jsonSchemaToZod(jsonSchema);
        // Use Function constructor instead of eval() to restrict scope.
        // Only `z` (zod) is available — no access to process, require, globals, etc.
        const zodSchema = new Function('z', `"use strict"; return (${zodSchemaString});`)(z);
        if (typeof zodSchema?.parse !== 'function') {
            throw new Error('Function did not produce a valid Zod schema.');
        }
        return zodSchema as z.ZodTypeAny;
    } catch (err: any) {
        log.warn(`Failed to generate/evaluate Zod schema for '${toolName}':`, err);
        return z.object({}).passthrough();
    }
}
