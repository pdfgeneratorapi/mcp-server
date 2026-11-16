import {
  Server,
  type Tool,
  type CallToolResult,
  type CallToolRequest,
  type ServerContext
} from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { SERVER_ICON } from './icon.js';
import { log } from './logger.js';
import { simplifySchemaForOpenAI } from './schema.js';
import { catalogue } from './catalogue.js';
import { toolAnnotations } from './annotations.js';
import {
    CALL_OPERATION,
    DESCRIBE_OPERATION,
    READ_OPERATION,
    SEARCH_OPERATIONS,
    describeOperationsResult,
    grantedOperations,
    metaTools,
    resolveRun,
    searchOperationsResult,
} from './metaTools.js';
import { executeApiTool } from './execute.js';
import { isEndedGrant, UpstreamCredentialError, type UpstreamCredentials } from './credentials/upstream.js';
import { loadScopeEnforcement, mayCallTool, visibleTools } from './auth/scopes.js';
import { builderToolOf, elapsedSince, type ToolCallRecord } from './telemetry.js';
import type { AuthInfo } from '@modelcontextprotocol/server';

/** Told how each tool call went, once it has an outcome. */
export type ToolCallObserver = (record: ToolCallRecord, extra: { authInfo?: AuthInfo; sessionId?: string }) => void;

const ENDED_CONNECTION_MESSAGE = 'This connection has ended: it was revoked, has expired, or is no longer known. '
    + 'Send the request again, and you will be asked to sign in.';

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
 * @param credentials Credentials for the API, resolved per call from the verified access token
 * @param onToolCall Told how each tool call went
 */
export function createMcpServer(credentials?: UpstreamCredentials, onToolCall?: ToolCallObserver): Server {
    const server = new Server(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
            title: "PDF Generator API",
            description: "MCP server for the PDF Generator API — generate PDFs from templates, manage templates and workspaces, watermark, encrypt, optimize, convert HTML/URL to PDF, fill PDF forms, create e-invoices, generate QR codes, and more.",
            websiteUrl: "https://pdfgeneratorapi.com",
            icons: [SERVER_ICON],
        },
        {
            capabilities: { tools: {}, prompts: {} },
            instructions: "This MCP server wraps the PDF Generator API v4. Use it to generate PDF documents from templates, manage templates and workspaces, convert HTML/URLs to PDF, create e-invoices (UBL, CII, XRechnung, Factur-X), and perform PDF operations like watermarking, encryption, optimization, accessibility tagging, and form filling. Start by listing templates with get_templates, then generate documents with generate_document. To build or restyle a template step by step, or change a few of its components without resending it, read get_builder_guide, list the steps with list_builder_tools and apply them with run_builder_tool. To see how a template looks, saved or not, call preview_template: it shows up to 3 of its pages as images, free and stored nowhere; show_pdf_pages does the same for a PDF you already have. Don't generate a document just to look at it: generate_document uses credits, and output url stores the document for 30 days. To read a template only for its structure, pass images: omit to get_template, get_template_version, get_template_library_item or get_template_library_items: every embedded image is replaced by a short marker naming its type and size. A saved template read that way is changed with run_builder_tool, which keeps its images; a definition that still carries a marker is refused wherever it is sent, so to base a new template on a library template, read that one with its images. To open several library templates, use get_template_library_items with up to 5 ids in one call, with images: omit unless the images are needed. To size a text box, measure its text with measure_text, up to 20 texts in one call: it returns the lines a text breaks into at a width and its height, as the PDF draws them, so the box is neither cut nor too tall. Take every fontFamily from list_fonts. The connection acts in the workspace the user chose when connecting, with the permissions they granted; tools outside those permissions are not listed.",
        }
    );

    server.setRequestHandler('tools/list', async (_request, ctx) => {
        const enforcement = loadScopeEnforcement();
        const scopes = ctx.http?.authInfo?.scopes ?? [];
        const allowed = enforcement === 'off' ? null : new Set(visibleTools(scopes));
        const operationTools: Tool[] = Array.from(catalogue.values())
            .filter(def => allowed === null || allowed.has(def.name))
            .map(def => ({
            name: def.name,
            description: def.description,
            inputSchema: simplifySchemaForOpenAI(def.inputSchema),
            annotations: toolAnnotations[def.name],
        }));
        const searchTools: Tool[] = Array.from(metaTools.values()).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: simplifySchemaForOpenAI(tool.inputSchema),
            annotations: tool.annotations,
        }));
        return { tools: [...searchTools, ...operationTools] };
    });

    server.setRequestHandler('tools/call', async (request: CallToolRequest, ctx: ServerContext): Promise<CallToolResult> => {
        const extra = { authInfo: ctx.http?.authInfo, sessionId: ctx.sessionId };
        const startedAt = performance.now();
        const { name: toolName, arguments: toolArgs } = request.params;
        const builderTool = builderToolOf(toolName, toolArgs);
        const observe = (details: Omit<ToolCallRecord, 'tool' | 'builderTool' | 'durationMs'>) =>
            onToolCall?.({ tool: toolName, builderTool, durationMs: elapsedSince(startedAt), ...details }, extra);
        const enforcement = loadScopeEnforcement();
        const scopes = extra.authInfo?.scopes ?? [];

        if (toolName === SEARCH_OPERATIONS || toolName === DESCRIBE_OPERATION) {
            const granted = grantedOperations(scopes, enforcement);
            const result = toolName === SEARCH_OPERATIONS
                ? searchOperationsResult(toolArgs ?? {}, granted)
                : describeOperationsResult(toolArgs ?? {}, granted);
            observe({ outcome: result.isError ? 'error' : 'ok' });
            return result;
        }

        let operationName = toolName;
        let operationArgs = toolArgs ?? {};
        let toolDefinition = catalogue.get(toolName);

        if (toolName === READ_OPERATION || toolName === CALL_OPERATION) {
            const run = resolveRun(toolName, toolArgs ?? {});

            if ('refusal' in run) {
                observe({ outcome: 'refused', refusal: run.refusal });
                return { content: [{ type: "text", text: `Error: ${run.message}` }], isError: true };
            }

            operationName = run.operation.id;
            operationArgs = run.args;
            toolDefinition = run.operation.definition;
        }

        if (!toolDefinition) {
            log.warn(`Unknown tool requested: ${toolName}`);
            observe({ outcome: 'refused', refusal: 'unknown_tool' });
            return { content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }], isError: true };
        }
        const decision = mayCallTool(operationName, scopes, operationArgs);

        if (!decision.allowed && enforcement !== 'off') {
            log.warn(`Tool "${operationName}" needs scope "${decision.required}", which this token does not grant`);

            if (enforcement === 'enforce') {
                observe({ outcome: 'refused', refusal: 'insufficient_scope' });
                return {
                    content: [{ type: "text", text: `Error: this connection is not allowed to call "${operationName}". It needs the "${decision.required}" permission; reconnect and grant it.` }],
                    isError: true,
                };
            }
        }

        let ended = false;
        const upstreamAuth = credentials && {
            getToken: () => credentials.get(extra.authInfo).catch((error: unknown) => {
                if (!isEndedGrant(error)) {
                    throw error;
                }

                // The HTTP layer challenges the next request; this one can only say so.
                ended = true;
                throw new UpstreamCredentialError(ENDED_CONNECTION_MESSAGE, error.status, error.code, { cause: error });
            }),
            invalidate: () => credentials.invalidate(extra.authInfo),
        };
        let upstreamStatus: number | undefined;
        const result = await executeApiTool(operationName, toolDefinition, operationArgs, upstreamAuth, (status) => {
            upstreamStatus = status;
        });
        observe(ended
            ? { outcome: 'error', refusal: 'ended_grant', upstreamStatus }
            : { outcome: result.isError ? 'error' : 'ok', upstreamStatus });

        return result;
    });

    server.setRequestHandler('prompts/list', async () => {
        return { prompts };
    });

    server.setRequestHandler('prompts/get', async (request) => {
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
