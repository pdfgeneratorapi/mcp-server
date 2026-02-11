#!/usr/bin/env node
/**
 * MCP Server generated from OpenAPI spec for ar-api-production v4.0.17
 * Generated on: 2026-02-06T09:23:03.963Z
 */

// Load environment variables from .env file
import dotenv from 'dotenv';
dotenv.config();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { setupStreamableHttpServer } from "./streamable-http.js";

import { z, ZodError } from 'zod';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

/**
 * Type definition for JSON objects
 */
type JsonObject = Record<string, any>;

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
    securityRequirements: any[];
}

/**
 * Server configuration
 */
export const SERVER_NAME = "ar-api-production";
export const SERVER_VERSION = "4.0.17";
export const API_BASE_URL = process.env.API_BASE_URL || "https://us1.pdfgeneratorapi.com/api/v4";

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

/**
 * Factory function to create new MCP Server instances
 * Each connection needs its own server instance
 * @param bearerToken Optional bearer token for authentication (required for API calls)
 */
export function createMcpServer(bearerToken?: string): Server {
    const server = new Server(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { capabilities: { tools: {} } }
    );

    // Set up request handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const toolsForClient: Tool[] = Array.from(toolDefinitionMap.values()).map(def => ({
            name: def.name,
            description: def.description,
            inputSchema: simplifySchemaForOpenAI(def.inputSchema)
        }));
        return { tools: toolsForClient };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
        const { name: toolName, arguments: toolArgs } = request.params;
        const toolDefinition = toolDefinitionMap.get(toolName);
        if (!toolDefinition) {
            console.error(`Error: Unknown tool requested: ${toolName}`);
            return { content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }] };
        }
        return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, securitySchemes, bearerToken);
    });

    return server;
}

/**
 * MCP Server instance (for backwards compatibility)
 */
const server = createMcpServer();

/**
 * Map of tool definitions by name
 */
const toolDefinitionMap: Map<string, McpToolDefinition> = new Map([

  ["getStatus", {
    name: "getStatus",
    description: `Returns service status / health`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/status",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["addWatermark", {
    name: "addWatermark",
    description: `Adds a text or an image watermark to PDF document from base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url","watermark"],"properties":{"file_url":{"description":"PDF file from remote URL to add the watermark to","type":"string"},"watermark":{"type":"object","properties":{"image":{"anyOf":[{"type":"object","required":["content_url"],"properties":{"content_url":{"description":"URL to an image","type":"string"},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0},"scale":{"description":"Watermark image scale","type":"number","minimum":0.05,"maximum":1,"default":1}}},{"type":"object","required":["content_base64"],"properties":{"content_base64":{"description":"Base64 image string","type":"string"},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0},"scale":{"description":"Watermark image scale","type":"number","minimum":0.05,"maximum":1,"default":1}}}]},"text":{"type":"object","required":["content"],"properties":{"content":{"description":"Watermark text","type":"string"},"color":{"description":"Watermark text color in hexadecimal format","type":"string","default":"#000000"},"size":{"description":"Watermark text font size in px","type":"integer","minimum":7,"maximum":80,"default":48},"opacity":{"description":"Watermark text opaxity","type":"number","minimum":0.1,"maximum":1,"default":0.5},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0}}}}},"output":{"description":"Returned document output","type":"string","enum":["file","base64","url"],"default":"base64"},"name":{"description":"File name of the returned document","type":"string"}}},{"type":"object","required":["file_base64","watermark"],"properties":{"file_base64":{"description":"PDF file from base64 string to add the watermark to","type":"string"},"watermark":{"type":"object","properties":{"image":{"anyOf":[{"type":"object","required":["content_url"],"properties":{"content_url":{"description":"URL to an image","type":"string"},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0},"scale":{"description":"Watermark image scale","type":"number","minimum":0.05,"maximum":1,"default":1}}},{"type":"object","required":["content_base64"],"properties":{"content_base64":{"description":"Base64 image string","type":"string"},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0},"scale":{"description":"Watermark image scale","type":"number","minimum":0.05,"maximum":1,"default":1}}}]},"text":{"type":"object","required":["content"],"properties":{"content":{"description":"Watermark text","type":"string"},"color":{"description":"Watermark text color in hexadecimal format","type":"string","default":"#000000"},"size":{"description":"Watermark text font size in px","type":"integer","minimum":7,"maximum":80,"default":48},"opacity":{"description":"Watermark text opaxity","type":"number","minimum":0.1,"maximum":1,"default":0.5},"position":{"description":"Watermark position","type":"string","enum":["top-left","top-center","top-right","left","center","right","bottom-left","bottom-center","bottom-right"],"default":"center"},"rotation":{"description":"Watermark rotation","type":"integer","minimum":-180,"maximum":180,"default":0}}}}},"output":{"description":"Returned document output","type":"string","enum":["file","base64","url"],"default":"base64"},"name":{"description":"File name of the returned document","type":"string"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/watermark",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["encryptDocument", {
    name: "encryptDocument",
    description: `Encrypts a PDF document from base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url","owner_password"],"properties":{"file_url":{"description":"Public URL to a PDF document","type":"string","format":"https://examplepdf.com"},"owner_password":{"description":"An owner password to open the encrypted document","type":"string"},"user_password":{"description":"An user password to open the encrypted document","type":"string"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}},{"type":"object","required":["file_base64","owner_password"],"properties":{"file_base64":{"description":"PDF document in base64 encoded string format","type":"string"},"owner_password":{"description":"An owner password to open the encrypted document","type":"string"},"user_password":{"description":"An user password to open the encrypted document","type":"string"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/encrypt",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["decryptDocument", {
    name: "decryptDocument",
    description: `Decrypts an encrypted PDF document from base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url","owner_password"],"properties":{"file_url":{"description":"Public URL to a PDF document","type":"string","format":"https://examplepdf.com"},"owner_password":{"description":"An owner password to open the encrypted document","type":"string"},"user_password":{"description":"An user password to open the encrypted document","type":"string"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}},{"type":"object","required":["file_base64","owner_password"],"properties":{"file_base64":{"description":"PDF document in base64 encoded string format","type":"string"},"owner_password":{"description":"An owner password to open the encrypted document","type":"string"},"user_password":{"description":"An user password to open the encrypted document","type":"string"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/decrypt",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["optimizeDocument", {
    name: "optimizeDocument",
    description: `Optimizes the size of a PDF document from base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url"],"properties":{"file_url":{"description":"Public URL to a PDF document","type":"string","format":"https://examplepdf.com"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}},{"type":"object","required":["file_base64"],"properties":{"file_base64":{"description":"PDF document in base64 encoded string format","type":"string"},"name":{"description":"Name for the PDF file","type":"string"},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/optimize",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["extractFormFields", {
    name: "extractFormFields",
    description: `Extracts form fields and their metadata from a PDF document using base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url"],"properties":{"file_url":{"description":"Public URL to a PDF document","type":"string","format":"https://examplepdf.com"},"key_field":{"description":"Specifies which field is used to map the extract fields. If your document contains fields with the same name, then we suggest using the id field. Defaults to name.","type":"string","enum":["name","id"],"default":"name","example":"name"}}},{"type":"object","required":["file_base64"],"properties":{"file_base64":{"description":"PDF document in base64 encoded string format","type":"string"},"key_field":{"description":"Specifies which field is used to map the extract fields. If your document contains fields with the same name, then we suggest using the id field. Defaults to name.","type":"string","enum":["name","id"],"default":"name","example":"name"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/form/fields",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["fillFormFields", {
    name: "fillFormFields",
    description: `Fills form fields in a PDF document with provided data from base64 string or a remote URL.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url","data"],"properties":{"file_url":{"description":"Public URL to a PDF document","type":"string","format":"https://examplepdf.com"},"data":{"description":"Form field data to fill in the PDF","type":"object","example":{"firstName":"John","lastName":"Doe","email":"john.doe@example.com"}},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"},"name":{"description":"Name for the PDF file","type":"string"}}},{"type":"object","required":["file_base64","data"],"properties":{"file_base64":{"description":"PDF document in base64 encoded string format","type":"string"},"data":{"description":"Form field data to fill in the PDF","type":"object","example":{"firstName":"John","lastName":"Doe","email":"john.doe@example.com"}},"output":{"description":"Returned document output format","type":"string","enum":["file","base64","url"],"default":"base64"},"name":{"description":"Name for the PDF file","type":"string"}}}],"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/pdfservices/form/fill",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getTemplates", {
    name: "getTemplates",
    description: `Returns a list of templates available for the authenticated workspace`,
    inputSchema: {"type":"object","properties":{"name":{"type":"string","description":"Filter template by name"},"tags":{"type":"string","description":"Filter template by tags"},"access":{"type":"string","enum":["private","organization",""],"default":"","description":"Filter template by access type. No values returns all templates. private - returns only private templates, organization - returns only organization templates."},"page":{"type":"number","default":1,"description":"Pagination: page to return"},"per_page":{"type":"number","default":15,"description":"Pagination: How many records to return per page"}}},
    method: "get",
    pathTemplate: "/templates",
    executionParameters: [{"name":"name","in":"query"},{"name":"tags","in":"query"},{"name":"access","in":"query"},{"name":"page","in":"query"},{"name":"per_page","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["createTemplate", {
    name: "createTemplate",
    description: `Creates a new template. If template configuration is not specified in the request body then an empty template is created. Template is placed to the workspace specified in authentication params. Template configuration must be sent in the request body.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"description":"Template configuration","type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Template name"},"tags":{"type":"array","items":{"type":"string"},"description":"A list of tags assigned to a template"},"isDraft":{"type":"boolean","description":"Indicates if the template is a draft or published."},"layout":{"type":"object","description":"Defines template layout (e.g page format, margins).","properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","default":"A4"},"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"unit":{"type":"string","description":"Measure unit","enum":["cm","in"],"default":"cm"},"orientation":{"type":"string","description":"Page orientation","enum":["portrait","landscape"]},"rotation":{"type":"number","description":"Page rotation in degrees","enum":[0,90,180,270]},"margins":{"description":"Page margins in units","type":"object","properties":{"top":{"type":"number"},"right":{"type":"number"},"bottom":{"type":"number"},"left":{"type":"number"}}},"repeatLayout":{"description":"Defines page size if layout is repeated on the page e.g sheet labels","type":["object","null"],"properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","example":"A4"},"width":{"type":"number","description":"Page width in units","example":21},"height":{"type":"number","description":"Page height in units","example":29.7}}},"emptyLabels":{"description":"Specifies how many blank lables to add to sheet label.","type":"number","default":0}}},"pages":{"type":"array","description":"Defines page or label size, margins and components on page or label","items":{"type":"object","properties":{"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"margins":{"type":"object","properties":{"right":{"type":"number","description":"Page or label margin from right"},"bottom":{"type":"number","description":"Page or label margin from bottom"}}},"border":{"type":"boolean","default":false},"components":{"type":"array","items":{"type":"object"}},"layout":{"type":["object","null"],"description":"Defines page specific layout which can differ from the main template layout (e.g page format, margins)."},"conditionalFormats":{"type":"array","items":{"type":"object"}},"backgroundImage":{"type":["string","null"],"description":"Defines background image for the page."}}}},"dataSettings":{"type":"object","description":"Defines filter and sort option for root data set.","properties":{"sortBy":{"type":"array","items":{"type":"object"}},"filterBy":{"type":"array","items":{"type":"object"}},"transform":{"type":"array","items":{"type":"object"}}}},"editor":{"type":"object","description":"Configuration preferences for the editor","properties":{"heightMultiplier":{"type":"number"}}},"fontSubsetting":{"type":"boolean","description":"If font-subsetting is applied to document when generated","default":false},"barcodeAsImage":{"type":"boolean","description":"Defines if barcodes are rendered as raster images instead of vector graphics.","default":false}}}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/templates",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getTemplateSchema", {
    name: "getTemplateSchema",
    description: `Returns Template JSON Schema which defines the structure of the Template Definition.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/templates/schema",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["importTemplate", {
    name: "importTemplate",
    description: `Creates a template from existing PDF`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url","template"],"properties":{"template":{"type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Template name","example":"Invoice template"}}},"file_url":{"description":"PDF file from remote URL to import","type":"string"}}},{"type":"object","required":["file_base64","template"],"properties":{"template":{"type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Template name","example":"Invoice template"}}},"file_base64":{"description":"PDF file from base64 string to import","type":"string"}}}],"description":"Import a PDF via URL or base64 string as template"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/templates/import",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["validateTemplate", {
    name: "validateTemplate",
    description: `Validates if the provided template configuration matches the template JSON schema.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"description":"Template configuration","type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Template name"},"tags":{"type":"array","items":{"type":"string"},"description":"A list of tags assigned to a template"},"isDraft":{"type":"boolean","description":"Indicates if the template is a draft or published."},"layout":{"type":"object","description":"Defines template layout (e.g page format, margins).","properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","default":"A4"},"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"unit":{"type":"string","description":"Measure unit","enum":["cm","in"],"default":"cm"},"orientation":{"type":"string","description":"Page orientation","enum":["portrait","landscape"]},"rotation":{"type":"number","description":"Page rotation in degrees","enum":[0,90,180,270]},"margins":{"description":"Page margins in units","type":"object","properties":{"top":{"type":"number"},"right":{"type":"number"},"bottom":{"type":"number"},"left":{"type":"number"}}},"repeatLayout":{"description":"Defines page size if layout is repeated on the page e.g sheet labels","type":["object","null"],"properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","example":"A4"},"width":{"type":"number","description":"Page width in units","example":21},"height":{"type":"number","description":"Page height in units","example":29.7}}},"emptyLabels":{"description":"Specifies how many blank lables to add to sheet label.","type":"number","default":0}}},"pages":{"type":"array","description":"Defines page or label size, margins and components on page or label","items":{"type":"object","properties":{"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"margins":{"type":"object","properties":{"right":{"type":"number","description":"Page or label margin from right"},"bottom":{"type":"number","description":"Page or label margin from bottom"}}},"border":{"type":"boolean","default":false},"components":{"type":"array","items":{"type":"object"}},"layout":{"type":["object","null"],"description":"Defines page specific layout which can differ from the main template layout (e.g page format, margins)."},"conditionalFormats":{"type":"array","items":{"type":"object"}},"backgroundImage":{"type":["string","null"],"description":"Defines background image for the page."}}}},"dataSettings":{"type":"object","description":"Defines filter and sort option for root data set.","properties":{"sortBy":{"type":"array","items":{"type":"object"}},"filterBy":{"type":"array","items":{"type":"object"}},"transform":{"type":"array","items":{"type":"object"}}}},"editor":{"type":"object","description":"Configuration preferences for the editor","properties":{"heightMultiplier":{"type":"number"}}},"fontSubsetting":{"type":"boolean","description":"If font-subsetting is applied to document when generated","default":false},"barcodeAsImage":{"type":"boolean","description":"Defines if barcodes are rendered as raster images instead of vector graphics.","default":false}}}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/templates/validate",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getTemplate", {
    name: "getTemplate",
    description: `Returns template configuration`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"}},"required":["templateId"]},
    method: "get",
    pathTemplate: "/templates/{templateId}",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["updateTemplate", {
    name: "updateTemplate",
    description: `Updates template configuration. The template configuration for pages and layout must be complete as the entire configuration is replaced and not merged.`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"requestBody":{"description":"Template configuration","type":"object","required":["name"],"properties":{"name":{"type":"string","description":"Template name"},"tags":{"type":"array","items":{"type":"string"},"description":"A list of tags assigned to a template"},"isDraft":{"type":"boolean","description":"Indicates if the template is a draft or published."},"layout":{"type":"object","description":"Defines template layout (e.g page format, margins).","properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","default":"A4"},"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"unit":{"type":"string","description":"Measure unit","enum":["cm","in"],"default":"cm"},"orientation":{"type":"string","description":"Page orientation","enum":["portrait","landscape"]},"rotation":{"type":"number","description":"Page rotation in degrees","enum":[0,90,180,270]},"margins":{"description":"Page margins in units","type":"object","properties":{"top":{"type":"number"},"right":{"type":"number"},"bottom":{"type":"number"},"left":{"type":"number"}}},"repeatLayout":{"description":"Defines page size if layout is repeated on the page e.g sheet labels","type":["object","null"],"properties":{"format":{"type":"string","enum":["A4","letter","custom"],"description":"Defines template page size","example":"A4"},"width":{"type":"number","description":"Page width in units","example":21},"height":{"type":"number","description":"Page height in units","example":29.7}}},"emptyLabels":{"description":"Specifies how many blank lables to add to sheet label.","type":"number","default":0}}},"pages":{"type":"array","description":"Defines page or label size, margins and components on page or label","items":{"type":"object","properties":{"width":{"type":"number","description":"Page width in units"},"height":{"type":"number","description":"Page height in units"},"margins":{"type":"object","properties":{"right":{"type":"number","description":"Page or label margin from right"},"bottom":{"type":"number","description":"Page or label margin from bottom"}}},"border":{"type":"boolean","default":false},"components":{"type":"array","items":{"type":"object"}},"layout":{"type":["object","null"],"description":"Defines page specific layout which can differ from the main template layout (e.g page format, margins)."},"conditionalFormats":{"type":"array","items":{"type":"object"}},"backgroundImage":{"type":["string","null"],"description":"Defines background image for the page."}}}},"dataSettings":{"type":"object","description":"Defines filter and sort option for root data set.","properties":{"sortBy":{"type":"array","items":{"type":"object"}},"filterBy":{"type":"array","items":{"type":"object"}},"transform":{"type":"array","items":{"type":"object"}}}},"editor":{"type":"object","description":"Configuration preferences for the editor","properties":{"heightMultiplier":{"type":"number"}}},"fontSubsetting":{"type":"boolean","description":"If font-subsetting is applied to document when generated","default":false},"barcodeAsImage":{"type":"boolean","description":"Defines if barcodes are rendered as raster images instead of vector graphics.","default":false}}}},"required":["templateId","requestBody"]},
    method: "put",
    pathTemplate: "/templates/{templateId}",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["deleteTemplate", {
    name: "deleteTemplate",
    description: `Deletes the template from workspace`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"}},"required":["templateId"]},
    method: "delete",
    pathTemplate: "/templates/{templateId}",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["getTemplateData", {
    name: "getTemplateData",
    description: `Returns all data fields used in the template. Returns structured JSON data that can be used to check which data fields are used in template or autogenerate sample data.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"}},"required":["templateId"]},
    method: "get",
    pathTemplate: "/templates/{templateId}/data",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["copyTemplate", {
    name: "copyTemplate",
    description: `Creates a copy of a template to the workspace specified in authentication parameters.`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"requestBody":{"type":"object","properties":{"name":{"description":"Name for the copied template. If name is not specified then the original name is used.","type":"string"}},"description":"The JSON request body."}},"required":["templateId"]},
    method: "post",
    pathTemplate: "/templates/{templateId}/copy",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["openEditor", {
    name: "openEditor",
    description: `Returns an unique URL which you can use to redirect your user to the editor from your application or use the generated URL as iframe source to show the editor within your application.
When using iframe, make sure that your browser allows third-party cookies.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"requestBody":{"type":"object","properties":{"data":{"description":"Data used to generate the document. This can be an object or array of objects.","oneOf":[{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},{"type":"array","description":"JSON data used to replace data fields in the template","items":{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},"example":[{"id":123,"name":"John Smith","birthdate":"2000-05-12","role":"Developer"},{"id":123,"name":"Jane Doe","birthdate":"1999-03-12","role":"Manager"}]}]},"language":{"type":"string","enum":["en","et","cs","sk","ru","de"],"description":"Specify the editor UI language. Defaults to organization editor language."}},"description":"The JSON request body."}},"required":["templateId","requestBody"]},
    method: "post",
    pathTemplate: "/templates/{templateId}/editor",
    executionParameters: [{"name":"templateId","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["listTemplateVersions", {
    name: "listTemplateVersions",
    description: `Returns a paginated list of template versions for the specified template.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"per_page":{"type":"number","description":"Number of items per page."},"page":{"type":"number","description":"Page number to return."}},"required":["templateId"]},
    method: "get",
    pathTemplate: "/templates/{templateId}/versions",
    executionParameters: [{"name":"templateId","in":"path"},{"name":"per_page","in":"query"},{"name":"page","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["getTemplateVersion", {
    name: "getTemplateVersion",
    description: `Returns the template definition of the specified version.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"templateVersion":{"type":"number","description":"Unique ID of the template version."}},"required":["templateId","templateVersion"]},
    method: "get",
    pathTemplate: "/templates/{templateId}/versions/{templateVersion}",
    executionParameters: [{"name":"templateId","in":"path"},{"name":"templateVersion","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["deleteTemplateVersion", {
    name: "deleteTemplateVersion",
    description: `Deletes the specified template version.
Production versions cannot be deleted.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"templateVersion":{"type":"number","description":"Unique ID of the template version."}},"required":["templateId","templateVersion"]},
    method: "delete",
    pathTemplate: "/templates/{templateId}/versions/{templateVersion}",
    executionParameters: [{"name":"templateId","in":"path"},{"name":"templateVersion","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["promoteTemplateVersion", {
    name: "promoteTemplateVersion",
    description: `Promotes the specified template version to production.
Only one version can be production at a time.
`,
    inputSchema: {"type":"object","properties":{"templateId":{"type":"number","description":"Template unique identifier"},"templateVersion":{"type":"number","description":"Unique ID of the template version."}},"required":["templateId","templateVersion"]},
    method: "put",
    pathTemplate: "/templates/{templateId}/versions/{templateVersion}/promote",
    executionParameters: [{"name":"templateId","in":"path"},{"name":"templateVersion","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["getDocuments", {
    name: "getDocuments",
    description: `Returns a list of generated documents created by authorized workspace and stored in PDF Generator API. If master user is specified as workspace in JWT then all documents created in the organization are returned. NB! This endpoint returns only documents generated using the output=url option.`,
    inputSchema: {"type":"object","properties":{"template_id":{"type":"number","description":"Template unique identifier"},"start_date":{"type":"string","description":"Start date. Format: Y-m-d H:i:s"},"end_date":{"type":"string","description":"End date. Format: Y-m-d H:i:s. Defaults to current timestamp"},"page":{"type":"number","default":1,"description":"Pagination: page to return"},"per_page":{"type":"number","default":15,"description":"Pagination: How many records to return per page"}}},
    method: "get",
    pathTemplate: "/documents",
    executionParameters: [{"name":"template_id","in":"query"},{"name":"start_date","in":"query"},{"name":"end_date","in":"query"},{"name":"page","in":"query"},{"name":"per_page","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["getDocument", {
    name: "getDocument",
    description: `Returns document stored in the Document Storage`,
    inputSchema: {"type":"object","properties":{"publicId":{"type":"string","description":"Resource public id"}},"required":["publicId"]},
    method: "get",
    pathTemplate: "/documents/{publicId}",
    executionParameters: [{"name":"publicId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["deleteDocument", {
    name: "deleteDocument",
    description: `Delete document from the Document Storage`,
    inputSchema: {"type":"object","properties":{"publicId":{"type":"string","description":"Resource public id"}},"required":["publicId"]},
    method: "delete",
    pathTemplate: "/documents/{publicId}",
    executionParameters: [{"name":"publicId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["generateDocument", {
    name: "generateDocument",
    description: `Merges template with data and returns base64 encoded document or a public URL to a document. NB! When the public URL option is used, the document is stored for 30 days and automatically deleted.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"template":{"type":"object","description":"Template id, version, version id and data","properties":{"id":{"type":"number","description":"Template ID"},"version_id":{"type":"number","description":"Template version ID"},"data":{"oneOf":[{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},{"type":"array","description":"JSON data used to replace data fields in the template","items":{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},"example":[{"id":123,"name":"John Smith","birthdate":"2000-05-12","role":"Developer"},{"id":123,"name":"Jane Doe","birthdate":"1999-03-12","role":"Manager"}]}]}}},"format":{"description":"Document format. The zip option will return a ZIP file with PDF files.","type":"string","enum":["pdf","html","zip","xlsx"],"default":"pdf"},"output":{"description":"Response format. When the \"file\" option is used the API returns the file inline. With the \"url\" and \"viewer\" option, the document is stored for 30 days and automatically deleted.","type":"string","enum":["base64","url","file","viewer"],"default":"base64"},"name":{"type":"string","description":"Generated document name (optional)","default":""},"testing":{"type":"boolean","description":"When set to true the generation is not counted as merge (monthly usage), but a large PREVIEW stamp is added.","default":false},"metadata":{"type":"object","description":"Metadata object (optional)","properties":{"author":{"type":"string","description":"Document author","default":"Organization name"},"language":{"type":"string","description":"Document language","default":"en"}}}},"description":"Request parameters, including template id, data and formats."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/documents/generate",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["generateDocumentAsynchronous", {
    name: "generateDocumentAsynchronous",
    description: `Merges template with data as asynchronous job and makes POST request to callback URL defined in the request. Request uses the same format as response of synchronous generation endpoint.
The job id is also added to the callback request as header PDF-API-Job-Id

*Example response from callback URL:*
\`\`\`
{
  "response": "https://us1.pdfgeneratorapi.com/share/12821/VBERi0xLjcKJeLjz9MKNyAwIG9i",
  "meta": {
    "name": "a2bd25b8921f3dc7a440fd7f427f90a4.pdf",
    "display_name": "a2bd25b8921f3dc7a440fd7f427f90a4",
    "encoding": "binary",
    "content-type": "application/pdf"
  }
}
\`\`\`
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"template":{"type":"object","description":"Template id, version, version id and data","properties":{"id":{"type":"number","description":"Template ID"},"version_id":{"type":"number","description":"Template version ID"},"data":{"oneOf":[{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},{"type":"array","description":"JSON data used to replace data fields in the template","items":{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},"example":[{"id":123,"name":"John Smith","birthdate":"2000-05-12","role":"Developer"},{"id":123,"name":"Jane Doe","birthdate":"1999-03-12","role":"Manager"}]}]}}},"callback":{"type":"object","description":"Callback URL and optional headers","properties":{"url":{"type":"string","description":"Public callback URL that is used to make a POST request when the document is generated."},"headers":{"type":"object","description":"A key-value pairs of header values sent with the POST request."}}},"format":{"description":"Document format. The zip option will return a ZIP file with PDF files.","type":"string","enum":["pdf","html","zip","xlsx"],"default":"pdf"},"output":{"description":"The generated document is returned as base64 string or URL which is stored for 30 days and automatically deleted.","type":"string","enum":["base64","url","viewer"],"default":"base64"},"name":{"type":"string","description":"Generated document name (optional)","default":""},"testing":{"type":"boolean","description":"When set to true the generation is not counted as merge (monthly usage), but a large PREVIEW stamp is added.","default":false},"metadata":{"type":"object","description":"Metadata object (optional)","properties":{"author":{"type":"string","description":"Document author","default":"Organization name"},"language":{"type":"string","description":"Document language","default":"en"}}}},"description":"Request parameters, including template id, data and formats."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/documents/generate/async",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["generateDocumentBatch", {
    name: "generateDocumentBatch",
    description: `Allows to merge multiple templates with data and returns base64 encoded document or public URL to a document. NB! When the public URL option is used, the document is stored for 30 days and automatically deleted.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"template":{"type":"array","items":{"type":"object","description":"Template id, version, version id and data","properties":{"id":{"type":"number","description":"Template ID"},"version_id":{"type":"number","description":"Template version ID"},"data":{"oneOf":[{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},{"type":"array","description":"JSON data used to replace data fields in the template","items":{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},"example":[{"id":123,"name":"John Smith","birthdate":"2000-05-12","role":"Developer"},{"id":123,"name":"Jane Doe","birthdate":"1999-03-12","role":"Manager"}]}]}}}},"format":{"description":"Document format. The zip option will return a ZIP file with PDF files.","type":"string","enum":["pdf","html","zip","xlsx"],"default":"pdf"},"output":{"description":"Response format. When the \"file\" option is used the API returns the file inline. With the \"url\" and \"viewer\" option, the document is stored for 30 days and automatically deleted.","type":"string","enum":["base64","url","file","viewer"],"default":"base64"},"name":{"type":"string","description":"Generated document name (optional)","default":""},"testing":{"type":"boolean","description":"When set to true the generation is not counted as merge (monthly usage), but a large PREVIEW stamp is added.","default":false},"metadata":{"type":"object","description":"Metadata object (optional)","properties":{"author":{"type":"string","description":"Document author","default":"Organization name"},"language":{"type":"string","description":"Document language","default":"en"}}}},"description":"Request parameters, including template id, data and formats."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/documents/generate/batch",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["generateDocumentBatchAsynchronous", {
    name: "generateDocumentBatchAsynchronous",
    description: `Merges template with data as asynchronous job and makes POST request to callback URL defined in the request. Request uses the same format as response of synchronous generation endpoint.
The job id is also added to the callback request as header PDF-API-Job-Id

*Example response from callback URL:*
\`\`\`
{
  "response": "https://us1.pdfgeneratorapi.com/share/12821/VBERi0xLjcKJeLjz9MKNyAwIG9i",
  "meta": {
    "name": "a2bd25b8921f3dc7a440fd7f427f90a4.pdf",
    "display_name": "a2bd25b8921f3dc7a440fd7f427f90a4",
    "encoding": "binary",
    "content-type": "application/pdf"
  }
}
\`\`\`
`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"template":{"type":"array","items":{"type":"object","description":"Template id, version, version id and data","properties":{"id":{"type":"number","description":"Template ID"},"version_id":{"type":"number","description":"Template version ID"},"data":{"oneOf":[{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},{"type":"array","description":"JSON data used to replace data fields in the template","items":{"type":"object","description":"JSON data used to replace data fields in the template","example":{"id":123,"name":"John Smith","birthdate":"2000-01-01","role":"Developer"}},"example":[{"id":123,"name":"John Smith","birthdate":"2000-05-12","role":"Developer"},{"id":123,"name":"Jane Doe","birthdate":"1999-03-12","role":"Manager"}]}]}}}},"callback":{"type":"object","description":"Callback URL and optional headers","properties":{"url":{"type":"string","description":"Public callback URL that is used to make a POST request when the document is generated."},"headers":{"type":"object","description":"A key-value pairs of header values sent with the POST request."}}},"format":{"description":"Document format. The zip option will return a ZIP file with PDF files.","type":"string","enum":["pdf","html","zip","xlsx"],"default":"pdf"},"output":{"description":"The generated document is returned as base64 string or URL which is stored for 30 days and automatically deleted.","type":"string","enum":["base64","url","viewer"],"default":"base64"},"name":{"type":"string","description":"Generated document name (optional)","default":""},"testing":{"type":"boolean","description":"When set to true the generation is not counted as merge (monthly usage), but a large PREVIEW stamp is added.","default":false},"metadata":{"type":"object","description":"Metadata object (optional)","properties":{"author":{"type":"string","description":"Document author","default":"Organization name"},"language":{"type":"string","description":"Document language","default":"en"}}}},"description":"Request parameters, including template id, data and formats."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/documents/generate/batch/async",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getAsyncJobStatus", {
    name: "getAsyncJobStatus",
    description: `Returns status of an async job`,
    inputSchema: {"type":"object","properties":{"jobId":{"type":"string","description":"Job id"}},"required":["jobId"]},
    method: "get",
    pathTemplate: "/documents/async/{jobId}",
    executionParameters: [{"name":"jobId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["getWorkspaces", {
    name: "getWorkspaces",
    description: `Returns all workspaces in the organization`,
    inputSchema: {"type":"object","properties":{"page":{"type":"number","default":1,"description":"Pagination: page to return"},"per_page":{"type":"number","default":15,"description":"Pagination: How many records to return per page"}}},
    method: "get",
    pathTemplate: "/workspaces",
    executionParameters: [{"name":"page","in":"query"},{"name":"per_page","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["createWorkspace", {
    name: "createWorkspace",
    description: `Creates a regular workspace with identifier specified in the request.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"identifier":{"description":"A unique identifier of the workspace. Make sure that you can generate the same identifier for your user.","type":"string"}},"description":"The JSON request body."}}},
    method: "post",
    pathTemplate: "/workspaces",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getWorkspace", {
    name: "getWorkspace",
    description: `Returns workspace information for the workspace identifier specified in the request.`,
    inputSchema: {"type":"object","properties":{"workspaceIdentifier":{"type":"string","description":"Workspace identifier"}},"required":["workspaceIdentifier"]},
    method: "get",
    pathTemplate: "/workspaces/{workspaceIdentifier}",
    executionParameters: [{"name":"workspaceIdentifier","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["deleteWorkspace", {
    name: "deleteWorkspace",
    description: `Delete workspace. Only regular workspaces can be deleted.`,
    inputSchema: {"type":"object","properties":{"workspaceIdentifier":{"type":"string","description":"Workspace identifier"}},"required":["workspaceIdentifier"]},
    method: "delete",
    pathTemplate: "/workspaces/{workspaceIdentifier}",
    executionParameters: [{"name":"workspaceIdentifier","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["convertHTML2PDF", {
    name: "convertHTML2PDF",
    description: `Converts HTML content to PDF`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"content":{"type":"string","description":"HTML content"},"paper_size":{"type":"string","description":"PDF page size","enum":["a0","a1","a2","a3","a4","legal","tabloid","letter"],"default":"a4"},"orientation":{"type":"string","enum":["portrait","landscape"],"default":"portrait"},"output":{"type":"string","description":"Output","enum":["base64","file"],"default":"base64"},"filename":{"type":"string","description":"Document name"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/conversion/html2pdf",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["convertURL2PDF", {
    name: "convertURL2PDF",
    description: `Converts public URL to PDF`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"url":{"type":"string","description":"Public URL"},"paper_size":{"type":"string","description":"PDF page size","enum":["a0","a1","a2","a3","a4","legal","tabloid","letter"],"default":"a4"},"orientation":{"type":"string","enum":["portrait","landscape"],"default":"portrait"},"output":{"type":"string","description":"Output","enum":["base64","file"],"default":"base64"},"filename":{"type":"string","description":"Document name"}},"description":"The JSON request body."}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/conversion/url2pdf",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getForms", {
    name: "getForms",
    description: `Returns a list of forms available for the organization`,
    inputSchema: {"type":"object","properties":{"page":{"type":"number","default":1,"description":"Pagination: page to return"},"per_page":{"type":"number","default":15,"description":"Pagination: How many records to return per page"}}},
    method: "get",
    pathTemplate: "/forms",
    executionParameters: [{"name":"page","in":"query"},{"name":"per_page","in":"query"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["createForm", {
    name: "createForm",
    description: `Creates a new form based on the configuration sent in the request body.`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","properties":{"template_id":{"type":"number","description":"Template ID which is connected to the form"},"name":{"type":"string","description":"Form name"},"actions":{"type":"array","description":"Array of action configurations","items":{"anyOf":[{"type":"object","description":"Key-value pair of action configuration.","properties":{"store_document":{"type":"boolean","example":true}}},{"type":"object","description":"Key-value pair of action configuration.","properties":{"download_document":{"type":"boolean","example":true}}}]}},"fields":{"type":"array","description":"A list of form field objects","items":{"type":"object","description":"Form field definition","properties":{"label":{"type":"string","description":"Field label displayed in the form"},"name":{"type":"string","description":"Data field name. For example \"name\" can be used as \"{name}\" in the document as placeholder."},"type":{"type":"string","description":"Field type","enum":["text","integer","number","date","signature"]},"required":{"type":"boolean","description":"Specifies if the field is required or not"}}}}},"description":"Form configuration"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/forms",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["importForm", {
    name: "importForm",
    description: `Creates a new form based on editable PDF`,
    inputSchema: {"type":"object","properties":{"requestBody":{"oneOf":[{"type":"object","required":["file_url"],"properties":{"file_url":{"description":"PDF file from remote URL to import","type":"string"},"form":{"type":"object","properties":{"template_id":{"type":"integer","description":"Template ID which is connected to the form","example":123123},"name":{"type":"string","description":"Form name","example":"Certificate creator"},"actions":{"type":"array","description":"Array of action configurations","items":{"anyOf":[{"type":"object","description":"Key-value pair of action configuration.","properties":{"store_document":{"type":"boolean","example":true}}},{"type":"object","description":"Key-value pair of action configuration.","properties":{"download_document":{"type":"boolean","example":true}}}]}},"fields":{"type":"array","description":"A list of form field objects","items":{"type":"object","description":"Form field definition","properties":{"label":{"type":"string","description":"Field label displayed in the form","example":"Full name"},"name":{"type":"string","description":"Data field name. For example \"name\" can be used as \"{name}\" in the document as placeholder.","example":"name"},"type":{"type":"string","description":"Field type","enum":["text","integer","number","date","signature"],"example":"text"},"required":{"type":"boolean","description":"Specifies if the field is required or not","example":false}}}}}}}},{"type":"object","required":["file_base64"],"properties":{"file_base64":{"description":"PDF file from base64 string to import","type":"string"},"form":{"type":"object","properties":{"template_id":{"type":"integer","description":"Template ID which is connected to the form","example":123123},"name":{"type":"string","description":"Form name","example":"Certificate creator"},"actions":{"type":"array","description":"Array of action configurations","items":{"anyOf":[{"type":"object","description":"Key-value pair of action configuration.","properties":{"store_document":{"type":"boolean","example":true}}},{"type":"object","description":"Key-value pair of action configuration.","properties":{"download_document":{"type":"boolean","example":true}}}]}},"fields":{"type":"array","description":"A list of form field objects","items":{"type":"object","description":"Form field definition","properties":{"label":{"type":"string","description":"Field label displayed in the form","example":"Full name"},"name":{"type":"string","description":"Data field name. For example \"name\" can be used as \"{name}\" in the document as placeholder.","example":"name"},"type":{"type":"string","description":"Field type","enum":["text","integer","number","date","signature"],"example":"text"},"required":{"type":"boolean","description":"Specifies if the field is required or not","example":false}}}}}}}}],"description":"Import editable PDF via URL or base64 string as form"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/forms/import",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getForm", {
    name: "getForm",
    description: `Returns form configuration`,
    inputSchema: {"type":"object","properties":{"formId":{"type":"number","description":"Form unique identifier"}},"required":["formId"]},
    method: "get",
    pathTemplate: "/forms/{formId}",
    executionParameters: [{"name":"formId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["updateForm", {
    name: "updateForm",
    description: `Updates the form configuration. The form configuration must be complete as the entire configuration is replaced and not merged.`,
    inputSchema: {"type":"object","properties":{"formId":{"type":"number","description":"Form unique identifier"},"requestBody":{"type":"object","properties":{"template_id":{"type":"number","description":"Template ID which is connected to the form"},"name":{"type":"string","description":"Form name"},"actions":{"type":"array","description":"Array of action configurations","items":{"anyOf":[{"type":"object","description":"Key-value pair of action configuration.","properties":{"store_document":{"type":"boolean","example":true}}},{"type":"object","description":"Key-value pair of action configuration.","properties":{"download_document":{"type":"boolean","example":true}}}]}},"fields":{"type":"array","description":"A list of form field objects","items":{"type":"object","description":"Form field definition","properties":{"label":{"type":"string","description":"Field label displayed in the form"},"name":{"type":"string","description":"Data field name. For example \"name\" can be used as \"{name}\" in the document as placeholder."},"type":{"type":"string","description":"Field type","enum":["text","integer","number","date","signature"]},"required":{"type":"boolean","description":"Specifies if the field is required or not"}}}}},"description":"Form configuration"}},"required":["formId","requestBody"]},
    method: "put",
    pathTemplate: "/forms/{formId}",
    executionParameters: [{"name":"formId","in":"path"}],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["deleteForm", {
    name: "deleteForm",
    description: `Deletes the form with specified id`,
    inputSchema: {"type":"object","properties":{"formId":{"type":"number","description":"Form unique identifier"}},"required":["formId"]},
    method: "delete",
    pathTemplate: "/forms/{formId}",
    executionParameters: [{"name":"formId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["shareForm", {
    name: "shareForm",
    description: `Creates an unique sharing URL to collect form data`,
    inputSchema: {"type":"object","properties":{"formId":{"type":"number","description":"Form unique identifier"}},"required":["formId"]},
    method: "post",
    pathTemplate: "/forms/{formId}/share",
    executionParameters: [{"name":"formId","in":"path"}],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
  ["generateQRCode", {
    name: "generateQRCode",
    description: `Creates a QR code based on the configuration`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["content"],"properties":{"content":{"type":"string","description":"The content which is used to generate QR code"},"color":{"description":"QR code in hexadecimal format","type":"string","default":"#000000"},"logo_base64":{"description":"A logo as a base64 image string to add on the QR code","type":"string"},"logo_url":{"description":"A logo URL to an image to add on the QR code","type":"string"},"output":{"description":"Response format","type":"string","enum":["file","base64"],"default":"base64"}},"description":"QR Code configuration"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/assets/qrcode",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["createEInvoice", {
    name: "createEInvoice",
    description: `This endpoint transforms a JSON payload into an XML-based e-invoice that is fully compliant with the European EN 16931 standard. The generated output can be formatted in either UBL (Universal Business Language) or CII (Cross-Industry Invoice) syntax, ensuring interoperability across B2B and B2G platforms. The JSON payload follows Peppol BIS Billing 3.0 UBL Invoice described here: https://docs.peppol.eu/poacc/billing/3.0/`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["data"],"properties":{"data":{"description":"JSON payload that represents the Peppol BIS Billing 3.0 UBL Invoice (https://docs.peppol.eu/poacc/billing/3.0/) Use the Get schema endpoint to see the detailed payload structure.","type":"object"},"type":{"description":"Formatting type.","type":"string","enum":["UBL","CII"],"default":"UBL"},"output":{"description":"Response format. When the \"file\" option is used the API returns the file inline.","type":"string","enum":["base64","file"],"default":"base64"}},"description":"eInvoice conversion"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/einvoice",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["createXRechnungEInvoice", {
    name: "createXRechnungEInvoice",
    description: `This endpoint transforms a JSON payload into an XML-based XRechnung e-invoice that is fully compliant with the European EN 16931 standard. The generated output follows the XRechnung format and can be formatted in either UBL (Universal Business Language) or CII (Cross-Industry Invoice) syntax, ensuring interoperability across B2B and B2G platforms. The JSON payload follows Peppol BIS Billing 3.0 UBL Invoice described here: https://docs.peppol.eu/poacc/billing/3.0/`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["data"],"properties":{"data":{"description":"JSON payload that represents the Peppol BIS Billing 3.0 UBL Invoice (https://docs.peppol.eu/poacc/billing/3.0/) Use the Get schema endpoint to see the detailed payload structure.","type":"object"},"type":{"description":"Formatting type.","type":"string","enum":["UBL","CII"],"default":"UBL"},"output":{"description":"Response format. When the \"file\" option is used the API returns the file inline.","type":"string","enum":["base64","file"],"default":"base64"}},"description":"eInvoice conversion"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/einvoice/xrechnung",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["createFacturXEInvoice", {
    name: "createFacturXEInvoice",
    description: `This endpoint transforms a JSON payload a Factur-X e-invoice that is fully compliant with the European EN 16931 standard. The generated output is always a PDF document, embedding a structured CII (Cross-Industry Invoice) XML according to the Factur-X format into a human-readable invoice, ensuring interoperability across B2B and B2G platforms. The JSON payload follows Peppol BIS Billing 3.0 UBL Invoice described here: https://docs.peppol.eu/poacc/billing/3.0/`,
    inputSchema: {"type":"object","properties":{"requestBody":{"type":"object","required":["template"],"properties":{"template":{"type":"object","description":"Template id, version, version id and data","properties":{"id":{"type":"number","description":"Template ID"},"version_id":{"type":"number","description":"Template version ID"},"data":{"description":"JSON payload that represents the Peppol BIS Billing 3.0 UBL Invoice (https://docs.peppol.eu/poacc/billing/3.0/) Use the Get schema endpoint to see the detailed payload structure.","type":"object"}}},"profile":{"description":"Factur-X conformance level.","type":"string","enum":["basic","basicwl","en16931","minimum","extended","xrechnung"],"default":"basic"},"output":{"description":"Response format. When the \"file\" option is used the API returns the file inline. With the \"url\" and \"viewer\" option, the document is stored for 30 days and automatically deleted.","type":"string","enum":["base64","url","file","viewer"],"default":"base64"},"name":{"type":"string","description":"Generated document name (optional)","default":""},"metadata":{"type":"object","description":"Metadata object (optional)","properties":{"author":{"type":"string","description":"Document author","default":"Organization name"},"language":{"type":"string","description":"Document language","default":"en"}}}},"description":"eInvoice conversion"}},"required":["requestBody"]},
    method: "post",
    pathTemplate: "/einvoice/facturx",
    executionParameters: [],
    requestBodyContentType: "application/json",
    securityRequirements: [{"JWT":[]}]
  }],
  ["getEInvoiceSchema", {
    name: "getEInvoiceSchema",
    description: `Returns e-invoice JSON schema which defines the structure of the e-invoice.`,
    inputSchema: {"type":"object","properties":{}},
    method: "get",
    pathTemplate: "/einvoice/schema",
    executionParameters: [],
    requestBodyContentType: undefined,
    securityRequirements: [{"JWT":[]}]
  }],
]);

/**
 * Security schemes from the OpenAPI spec
 */
const securitySchemes =   {
    "JWT": {
      "type": "http",
      "scheme": "bearer",
      "bearerFormat": "JWT",
      "description": "JSON Web Token (JWT) is an open standard (RFC 7519) that defines a compact and self-contained way for securely transmitting information between parties as a JSON object. This information can be verified and trusted because it is digitally signed. JWTs can be signed using a secret (with the HMAC algorithm) or a public/private key pair using RSA or ECDSA. For more information about JSON Web Tokens check [jwt.io](https://jwt.io).\n"
    }
  };


/**
 * Type definition for cached OAuth tokens
 */
interface TokenCacheEntry {
    token: string;
    expiresAt: number;
}

/**
 * Declare global __oauthTokenCache property for TypeScript
 */
declare global {
    var __oauthTokenCache: Record<string, TokenCacheEntry> | undefined;
}

/**
 * Acquires an OAuth2 token using client credentials flow
 * 
 * @param schemeName Name of the security scheme
 * @param scheme OAuth2 security scheme
 * @returns Acquired token or null if unable to acquire
 */
async function acquireOAuth2Token(schemeName: string, scheme: any): Promise<string | null | undefined> {
    try {
        // Check if we have the necessary credentials
        const clientId = process.env[`OAUTH_CLIENT_ID_SCHEMENAME`];
        const clientSecret = process.env[`OAUTH_CLIENT_SECRET_SCHEMENAME`];
        const scopes = process.env[`OAUTH_SCOPES_SCHEMENAME`];
        
        if (!clientId || !clientSecret) {
            console.error(`Missing client credentials for OAuth2 scheme '${schemeName}'`);
            return null;
        }
        
        // Initialize token cache if needed
        if (typeof global.__oauthTokenCache === 'undefined') {
            global.__oauthTokenCache = {};
        }
        
        // Check if we have a cached token
        const cacheKey = `${schemeName}_${clientId}`;
        const cachedToken = global.__oauthTokenCache[cacheKey];
        const now = Date.now();
        
        if (cachedToken && cachedToken.expiresAt > now) {
            console.error(`Using cached OAuth2 token for '${schemeName}' (expires in ${Math.floor((cachedToken.expiresAt - now) / 1000)} seconds)`);
            return cachedToken.token;
        }
        
        // Determine token URL based on flow type
        let tokenUrl = '';
        if (scheme.flows?.clientCredentials?.tokenUrl) {
            tokenUrl = scheme.flows.clientCredentials.tokenUrl;
            console.error(`Using client credentials flow for '${schemeName}'`);
        } else if (scheme.flows?.password?.tokenUrl) {
            tokenUrl = scheme.flows.password.tokenUrl;
            console.error(`Using password flow for '${schemeName}'`);
        } else {
            console.error(`No supported OAuth2 flow found for '${schemeName}'`);
            return null;
        }
        
        // Prepare the token request
        let formData = new URLSearchParams();
        formData.append('grant_type', 'client_credentials');
        
        // Add scopes if specified
        if (scopes) {
            formData.append('scope', scopes);
        }
        
        console.error(`Requesting OAuth2 token from ${tokenUrl}`);
        
        // Make the token request
        const response = await axios({
            method: 'POST',
            url: tokenUrl,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
            },
            data: formData.toString()
        });
        
        // Process the response
        if (response.data?.access_token) {
            const token = response.data.access_token;
            const expiresIn = response.data.expires_in || 3600; // Default to 1 hour
            
            // Cache the token
            global.__oauthTokenCache[cacheKey] = {
                token,
                expiresAt: now + (expiresIn * 1000) - 60000 // Expire 1 minute early
            };
            
            console.error(`Successfully acquired OAuth2 token for '${schemeName}' (expires in ${expiresIn} seconds)`);
            return token;
        } else {
            console.error(`Failed to acquire OAuth2 token for '${schemeName}': No access_token in response`);
            return null;
        }
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error acquiring OAuth2 token for '${schemeName}':`, errorMessage);
        return null;
    }
}


/**
 * Executes an API tool with the provided arguments
 *
 * @param toolName Name of the tool to execute
 * @param definition Tool definition
 * @param toolArgs Arguments provided by the user
 * @param allSecuritySchemes Security schemes from the OpenAPI spec
 * @param bearerToken Optional bearer token from request (overrides env var)
 * @returns Call tool result
 */
export async function executeApiTool(
    toolName: string,
    definition: McpToolDefinition,
    toolArgs: JsonObject,
    allSecuritySchemes: Record<string, any>,
    bearerToken?: string
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
            return { content: [{ type: 'text', text: validationErrorMessage }] };
        } else {
             const errorMessage = error instanceof Error ? error.message : String(error);
             return { content: [{ type: 'text', text: `Internal error during validation setup: ${errorMessage}` }] };
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
                headers[param.name.toLowerCase()] = String(value);
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


    // Apply security requirements if available
    // Security requirements use OR between array items and AND within each object
    const appliedSecurity = definition.securityRequirements?.find(req => {
        // Try each security requirement (combined with OR)
        return Object.entries(req).every(([schemeName, scopesArray]) => {
            const scheme = allSecuritySchemes[schemeName];
            if (!scheme) return false;
            
            // API Key security (header, query, cookie)
            if (scheme.type === 'apiKey') {
                return !!process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            }
            
            // HTTP security (basic, bearer)
            if (scheme.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    // Check if we have a bearer token from request
                    return !!bearerToken;
                }
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    return !!process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] &&
                           !!process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                }
            }
            
            // OAuth2 security
            if (scheme.type === 'oauth2') {
                // Check for pre-existing token
                if (process.env[`OAUTH_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]) {
                    return true;
                }
                
                // Check for client credentials for auto-acquisition
                if (process.env[`OAUTH_CLIENT_ID_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`] &&
                    process.env[`OAUTH_CLIENT_SECRET_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`]) {
                    // Verify we have a supported flow
                    if (scheme.flows?.clientCredentials || scheme.flows?.password) {
                        return true;
                    }
                }
                
                return false;
            }
            
            // OpenID Connect
            if (scheme.type === 'openIdConnect') {
                return !!process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
            }
            
            return false;
        });
    });

    // If we found matching security scheme(s), apply them
    if (appliedSecurity) {
        // Apply each security scheme from this requirement (combined with AND)
        for (const [schemeName, scopesArray] of Object.entries(appliedSecurity)) {
            const scheme = allSecuritySchemes[schemeName];
            
            // API Key security
            if (scheme?.type === 'apiKey') {
                const apiKey = process.env[`API_KEY_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                if (apiKey) {
                    if (scheme.in === 'header') {
                        headers[scheme.name.toLowerCase()] = apiKey;
                        console.error(`Applied API key '${schemeName}' in header '${scheme.name}'`);
                    }
                    else if (scheme.in === 'query') {
                        queryParams[scheme.name] = apiKey;
                        console.error(`Applied API key '${schemeName}' in query parameter '${scheme.name}'`);
                    }
                    else if (scheme.in === 'cookie') {
                        // Add the cookie, preserving other cookies if they exist
                        headers['cookie'] = `${scheme.name}=${apiKey}${headers['cookie'] ? `; ${headers['cookie']}` : ''}`;
                        console.error(`Applied API key '${schemeName}' in cookie '${scheme.name}'`);
                    }
                }
            } 
            // HTTP security (Bearer or Basic)
            else if (scheme?.type === 'http') {
                if (scheme.scheme?.toLowerCase() === 'bearer') {
                    // Use provided bearer token from request
                    if (bearerToken) {
                        headers['authorization'] = `Bearer ${bearerToken}`;
                        console.error(`Applied Bearer token for '${schemeName}' from request`);
                    }
                } 
                else if (scheme.scheme?.toLowerCase() === 'basic') {
                    const username = process.env[`BASIC_USERNAME_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    const password = process.env[`BASIC_PASSWORD_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                    if (username && password) {
                        headers['authorization'] = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
                        console.error(`Applied Basic authentication for '${schemeName}'`);
                    }
                }
            }
            // OAuth2 security
            else if (scheme?.type === 'oauth2') {
                // First try to use a pre-provided token
                let token = process.env[`OAUTH_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                
                // If no token but we have client credentials, try to acquire a token
                if (!token && (scheme.flows?.clientCredentials || scheme.flows?.password)) {
                    console.error(`Attempting to acquire OAuth token for '${schemeName}'`);
                    token = (await acquireOAuth2Token(schemeName, scheme)) ?? '';
                }
                
                // Apply token if available
                if (token) {
                    headers['authorization'] = `Bearer ${token}`;
                    console.error(`Applied OAuth2 token for '${schemeName}'`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(`Requested scopes: ${scopes.join(', ')}`);
                    }
                }
            }
            // OpenID Connect
            else if (scheme?.type === 'openIdConnect') {
                const token = process.env[`OPENID_TOKEN_${schemeName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}`];
                if (token) {
                    headers['authorization'] = `Bearer ${token}`;
                    console.error(`Applied OpenID Connect token for '${schemeName}'`);
                    
                    // List the scopes that were requested, if any
                    const scopes = scopesArray as string[];
                    if (scopes && scopes.length > 0) {
                        console.error(`Requested scopes: ${scopes.join(', ')}`);
                    }
                }
            }
        }
    } 
    // Log warning if security is required but not available
    else if (definition.securityRequirements?.length > 0) {
        // First generate a more readable representation of the security requirements
        const securityRequirementsString = definition.securityRequirements
            .map(req => {
                const parts = Object.entries(req)
                    .map(([name, scopesArray]) => {
                        const scopes = scopesArray as string[];
                        if (scopes.length === 0) return name;
                        return `${name} (scopes: ${scopes.join(', ')})`;
                    })
                    .join(' AND ');
                return `[${parts}]`;
            })
            .join(' OR ');
            
        console.warn(`Tool '${toolName}' requires security: ${securityRequirementsString}, but no suitable credentials found.`);
    }
    

    // Prepare the axios request configuration
    const config: AxiosRequestConfig = {
      method: definition.method.toUpperCase(), 
      url: requestUrl, 
      params: queryParams, 
      headers: headers,
      ...(requestBodyData !== undefined && { data: requestBodyData }),
    };

    // Log request info to stderr (doesn't affect MCP output)
    console.error(`Executing tool "${toolName}": ${config.method} ${config.url}`);
    
    // Execute the request
    const response = await axios(config);

    // Process and format the response
    let responseText = '';
    const contentType = response.headers['content-type']?.toLowerCase() || '';
    
    // Handle JSON responses
    if (contentType.includes('application/json') && typeof response.data === 'object' && response.data !== null) {
         try { 
             responseText = JSON.stringify(response.data, null, 2); 
         } catch (e) { 
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
    
    // Log error to stderr
    console.error(`Error during execution of tool '${toolName}':`, errorMessage);
    
    // Return error message to client
    return { content: [{ type: "text", text: errorMessage }] };
  }
}


/**
 * Main function to start the server
 */
async function main() {
  // Determine transport mode from command line arguments
  const args = process.argv.slice(2);
  const transportArg = args.find(arg => arg.startsWith('--transport='));
  const transport = transportArg ? transportArg.split('=')[1] : 'stdio';

  if (transport === 'streamable-http') {
    // Set up StreamableHTTP transport
    console.error('Starting MCP server in HTTP mode...');
    try {
      const port = parseInt(process.env.PORT || '3000', 10);
      await setupStreamableHttpServer(port);
    } catch (error) {
      console.error("Error setting up StreamableHTTP server:", error);
      process.exit(1);
    }
  } else {
    // Set up Stdio transport (default)
    console.error('Starting MCP server in stdio mode...');
    try {
      // In stdio mode, read bearer token from environment variable
      const bearerToken = process.env.BEARER_TOKEN_JWT;
      if (bearerToken) {
        console.error('Using Bearer token from BEARER_TOKEN_JWT environment variable');
      } else {
        console.error('No BEARER_TOKEN_JWT found in environment - API calls may fail without authentication');
      }

      const stdioServer = createMcpServer(bearerToken);
      const transport = new StdioServerTransport();
      await stdioServer.connect(transport);
      console.error('MCP server running in stdio mode');
    } catch (error) {
      console.error("Error setting up stdio transport:", error);
      process.exit(1);
    }
  }
}

/**
 * Cleanup function for graceful shutdown
 */
async function cleanup() {
    console.error("Shutting down MCP server...");
    process.exit(0);
}

// Register signal handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start the server
main().catch((error) => {
  console.error("Fatal error in main execution:", error);
  process.exit(1);
});

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
        const zodSchema = eval(zodSchemaString);
        if (typeof zodSchema?.parse !== 'function') { 
            throw new Error('Eval did not produce a valid Zod schema.'); 
        }
        return zodSchema as z.ZodTypeAny;
    } catch (err: any) {
        console.error(`Failed to generate/evaluate Zod schema for '${toolName}':`, err);
        return z.object({}).passthrough();
    }
}
