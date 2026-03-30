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
    get_status:                          { title: "Get API Status",                      readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    add_watermark:                       { title: "Add Watermark to PDF",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    encrypt_document:                    { title: "Encrypt PDF Document",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    decrypt_document:                    { title: "Decrypt PDF Document",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    optimize_document:                   { title: "Optimize PDF Size",                   readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    make_accessible:                     { title: "Add Accessibility Tags to PDF",       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    extract_form_fields:                  { title: "Extract Form Fields from PDF",        readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    fill_form_fields:                     { title: "Fill PDF Form Fields",                readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_templates:                       { title: "List Templates",                      readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    create_template:                     { title: "Create Template",                     readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_template_schema:                  { title: "Get Template JSON Schema",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    import_template:                     { title: "Import PDF as Template",              readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    validate_template:                   { title: "Validate Template Configuration",     readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    get_template:                        { title: "Get Template Details",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    update_template:                     { title: "Update Template",                     readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    delete_template:                     { title: "Delete Template",                     readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    get_template_data:                    { title: "Get Template Data Fields",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    copy_template:                       { title: "Copy Template",                       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    open_editor:                         { title: "Open Template Editor",                readOnlyHint: true,  destructiveHint: false,                        openWorldHint: true },
    list_template_versions:               { title: "List Template Versions",              readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    get_template_version:                 { title: "Get Template Version",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    delete_template_version:              { title: "Delete Template Version",             readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    promote_template_version:             { title: "Promote Template Version",            readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    get_documents:                       { title: "List Generated Documents",            readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    get_document:                        { title: "Get Document Details",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    delete_document:                     { title: "Delete Document",                     readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    generate_document:                   { title: "Generate PDF Document",               readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generate_document_async:       { title: "Generate PDF Document (Async)",       readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generate_document_batch:              { title: "Generate Batch PDF Documents",        readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generate_document_batch_async:  { title: "Generate Batch PDFs (Async)",         readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_async_job_status:                  { title: "Get Async Job Status",                readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    get_workspaces:                      { title: "List Workspaces",                     readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    create_workspace:                    { title: "Create Workspace",                    readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_workspace:                       { title: "Get Workspace Details",               readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    delete_workspace:                    { title: "Delete Workspace",                    readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    convert_html_to_pdf:                    { title: "Convert HTML to PDF",                 readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    convert_url_to_pdf:                     { title: "Convert URL to PDF",                  readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_forms:                           { title: "List Forms",                          readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    create_form:                         { title: "Create Form",                         readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    import_form:                         { title: "Import PDF as Form",                  readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_form:                            { title: "Get Form Details",                    readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    update_form:                         { title: "Update Form",                         readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true },
    delete_form:                         { title: "Delete Form",                         readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: true },
    share_form:                          { title: "Create Form Sharing URL",             readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    generate_qr_code:                     { title: "Generate QR Code",                    readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    create_einvoice:                     { title: "Create E-Invoice (UBL/CII)",          readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    create_xrechnung_einvoice:            { title: "Create XRechnung E-Invoice",          readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    create_facturx_einvoice:              { title: "Create Factur-X E-Invoice",           readOnlyHint: false, destructiveHint: false,                        openWorldHint: true },
    get_einvoice_schema:                  { title: "Get E-Invoice JSON Schema",           readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: true },
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
            instructions: "This MCP server wraps the PDF Generator API v4. Use it to generate PDF documents from templates, manage templates and workspaces, convert HTML/URLs to PDF, create e-invoices (UBL, CII, XRechnung, Factur-X), and perform PDF operations like watermarking, encryption, optimization, accessibility tagging, and form filling. Start by listing templates with get_templates, then generate documents with generate_document. Authentication is handled via JWT bearer token.",
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
                    content: { type: "text" as const, text: `Generate a PDF document using template ID ${templateId}. First, call get_template_data with templateId ${templateId} to see the required data fields, then call generate_document with the template ID, appropriate data, and output format "${outputFormat}".` }
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
                            ? `Convert the URL "${source}" to a PDF document using convert_url_to_pdf with paper size "${paperSize}" and portrait orientation.`
                            : `Convert the following HTML content to a PDF document using convert_html_to_pdf with paper size "${paperSize}" and portrait orientation:\n\n${source}`
                    }
                }]
            };
        }

        if (name === "create-einvoice") {
            const format = (args?.format || "UBL").toUpperCase();
            const tool = format === "FACTUR-X" || format === "FACTURX" ? "create_facturx_einvoice"
                : format === "XRECHNUNG" ? "create_xrechnung_einvoice"
                : "create_einvoice";
            return {
                messages: [{
                    role: "user" as const,
                    content: { type: "text" as const, text: `Create an e-invoice in ${format} format. First, call get_einvoice_schema to get the required data structure, then use ${tool} to generate the e-invoice.` }
                }]
            };
        }

        throw new Error(`Unknown prompt: ${name}`);
    });

    return server;
}
