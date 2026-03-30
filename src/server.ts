import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type CallToolResult,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { log } from './logger.js';
import { simplifySchemaForOpenAI } from './schema.js';
import { toolDefinitionMap } from './tools.js';
import { executeApiTool } from './execute.js';

/**
 * Tool annotations — hints for MCP clients about tool behavior
 */
const toolAnnotations: Record<string, { title: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }> = {
    getStatus:                          { title: "Get API Status",                      readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    addWatermark:                       { title: "Add Watermark to PDF",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    encryptDocument:                    { title: "Encrypt PDF Document",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    decryptDocument:                    { title: "Decrypt PDF Document",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    optimizeDocument:                   { title: "Optimize PDF Size",                   readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    makeAccessible:                     { title: "Add Accessibility Tags to PDF",       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    extractFormFields:                  { title: "Extract Form Fields from PDF",        readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    fillFormFields:                     { title: "Fill PDF Form Fields",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getTemplates:                       { title: "List Templates",                      readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    createTemplate:                     { title: "Create Template",                     readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getTemplateSchema:                  { title: "Get Template JSON Schema",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    importTemplate:                     { title: "Import PDF as Template",              readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    validateTemplate:                   { title: "Validate Template Configuration",     readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    getTemplate:                        { title: "Get Template Details",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    updateTemplate:                     { title: "Update Template",                     readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    deleteTemplate:                     { title: "Delete Template",                     readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    getTemplateData:                    { title: "Get Template Data Fields",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    copyTemplate:                       { title: "Copy Template",                       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    openEditor:                         { title: "Open Template Editor",                readOnlyHint: true,  destructiveHint: false,                        openWorldHint: true },
    listTemplateVersions:               { title: "List Template Versions",              readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    getTemplateVersion:                 { title: "Get Template Version",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    deleteTemplateVersion:              { title: "Delete Template Version",             readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    promoteTemplateVersion:             { title: "Promote Template Version",            readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    getDocuments:                       { title: "List Generated Documents",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    getDocument:                        { title: "Get Document Details",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    deleteDocument:                     { title: "Delete Document",                     readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    generateDocument:                   { title: "Generate PDF Document",               readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generateDocumentAsynchronous:       { title: "Generate PDF Document (Async)",       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generateDocumentBatch:              { title: "Generate Batch PDF Documents",        readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generateDocumentBatchAsynchronous:  { title: "Generate Batch PDFs (Async)",         readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getAsyncJobStatus:                  { title: "Get Async Job Status",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    getWorkspaces:                      { title: "List Workspaces",                     readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    createWorkspace:                    { title: "Create Workspace",                    readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getWorkspace:                       { title: "Get Workspace Details",               readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    deleteWorkspace:                    { title: "Delete Workspace",                    readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    convertHTML2PDF:                    { title: "Convert HTML to PDF",                 readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    convertURL2PDF:                     { title: "Convert URL to PDF",                  readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getForms:                           { title: "List Forms",                          readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    createForm:                         { title: "Create Form",                         readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    importForm:                         { title: "Import PDF as Form",                  readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getForm:                            { title: "Get Form Details",                    readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    updateForm:                         { title: "Update Form",                         readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    deleteForm:                         { title: "Delete Form",                         readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    shareForm:                          { title: "Create Form Sharing URL",             readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generateQRCode:                     { title: "Generate QR Code",                    readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    createEInvoice:                     { title: "Create E-Invoice (UBL/CII)",          readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    createXRechnungEInvoice:            { title: "Create XRechnung E-Invoice",          readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    createFacturXEInvoice:              { title: "Create Factur-X E-Invoice",           readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    getEInvoiceSchema:                  { title: "Get E-Invoice JSON Schema",           readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
};

/**
 * Prompt definitions for guided workflows
 */
const prompts = [
    {
        name: "generate-pdf",
        description: "Generate a PDF document by selecting a template and providing data to fill it with",
        arguments: [
            { name: "templateId", description: "The ID of the template to use for PDF generation", required: true },
            { name: "outputFormat", description: "Output format: base64, url, or file (default: url)", required: false },
        ]
    },
    {
        name: "convert-to-pdf",
        description: "Convert HTML content or a public URL to a PDF document",
        arguments: [
            { name: "source", description: "HTML content or public URL to convert to PDF", required: true },
            { name: "paperSize", description: "Paper size: a4, letter, a3, etc. (default: a4)", required: false },
        ]
    },
    {
        name: "create-einvoice",
        description: "Create an e-invoice compliant with EN 16931 standard in UBL, CII, XRechnung, or Factur-X format",
        arguments: [
            { name: "format", description: "E-invoice format: UBL, CII, XRechnung, or Factur-X", required: true },
        ]
    },
];

/**
 * Factory function to create new MCP Server instances
 * Each connection needs its own server instance
 * @param bearerToken Optional bearer token for authentication (required for API calls)
 */
export function createMcpServer(bearerToken?: string): Server {
    const server = new Server(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            title: "PDF Generator API",
            description: "MCP server for the PDF Generator API — generate PDFs from templates, manage templates and workspaces, watermark, encrypt, optimize, convert HTML/URL to PDF, fill PDF forms, create e-invoices, generate QR codes, and more.",
            websiteUrl: "https://pdfgeneratorapi.com",
            icons: [{ src: "https://pdfgeneratorapi.com/images/logo.svg" }],
        },
        {
            capabilities: { tools: {}, prompts: {} },
            instructions: "This MCP server wraps the PDF Generator API v4. Use it to generate PDF documents from templates, manage templates and workspaces, convert HTML/URLs to PDF, create e-invoices (UBL, CII, XRechnung, Factur-X), and perform PDF operations like watermarking, encryption, optimization, accessibility tagging, and form filling. Start by listing templates with getTemplates, then generate documents with generateDocument. Authentication is handled via JWT bearer token.",
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
        const toolsForClient: Tool[] = Array.from(toolDefinitionMap.values()).map(def => ({
            name: def.name,
            description: def.description,
            inputSchema: simplifySchemaForOpenAI(def.inputSchema),
            annotations: toolAnnotations[def.name],
        }));
        return { tools: toolsForClient };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
        const { name: toolName, arguments: toolArgs } = request.params;
        const toolDefinition = toolDefinitionMap.get(toolName);
        if (!toolDefinition) {
            log.warn(`Unknown tool requested: ${toolName}`);
            return { content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }], isError: true };
        }
        return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, bearerToken);
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
        return { prompts };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === "generate-pdf") {
            const templateId = args?.templateId || "<TEMPLATE_ID>";
            const outputFormat = args?.outputFormat || "url";
            return {
                messages: [{
                    role: "user" as const,
                    content: { type: "text" as const, text: `Generate a PDF document using template ID ${templateId}. First, call getTemplateData with templateId ${templateId} to see the required data fields, then call generateDocument with the template ID, appropriate data, and output format "${outputFormat}".` }
                }]
            };
        }

        if (name === "convert-to-pdf") {
            const source = args?.source || "";
            const paperSize = args?.paperSize || "a4";
            const isUrl = source.startsWith("http://") || source.startsWith("https://");
            return {
                messages: [{
                    role: "user" as const,
                    content: {
                        type: "text" as const,
                        text: isUrl
                            ? `Convert the URL "${source}" to a PDF document using convertURL2PDF with paper size "${paperSize}" and portrait orientation.`
                            : `Convert the following HTML content to a PDF document using convertHTML2PDF with paper size "${paperSize}" and portrait orientation:\n\n${source}`
                    }
                }]
            };
        }

        if (name === "create-einvoice") {
            const format = (args?.format || "UBL").toUpperCase();
            const tool = format === "FACTUR-X" || format === "FACTURX" ? "createFacturXEInvoice"
                : format === "XRECHNUNG" ? "createXRechnungEInvoice"
                : "createEInvoice";
            return {
                messages: [{
                    role: "user" as const,
                    content: { type: "text" as const, text: `Create an e-invoice in ${format} format. First, call getEInvoiceSchema to get the required data structure, then use ${tool} to generate the e-invoice.` }
                }]
            };
        }

        throw new Error(`Unknown prompt: ${name}`);
    });

    return server;
}
