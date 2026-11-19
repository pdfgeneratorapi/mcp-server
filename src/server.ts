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
import {
    CALL_OPERATION,
    DELETE_OPERATION,
    DESCRIBE_OPERATION,
    READ_OPERATION,
    SEARCH_OPERATIONS,
    describeOperationsResult,
    grantedOperations,
    isRunTool,
    metaTools,
    resolveRun,
    notGrantedMessage,
    searchOperationsResult,
    unknownTool,
} from './metaTools.js';
import { executeApiTool } from './execute.js';
import { isEndedGrant, UpstreamCredentialError, type UpstreamCredentials } from './credentials/upstream.js';
import { loadScopeEnforcement, mayCallTool } from './auth/scopes.js';
import { builderToolOf, elapsedSince, operationOf, type ToolCallRecord } from './telemetry.js';
import type { AuthInfo } from '@modelcontextprotocol/server';

/** Told how each tool call went, once it has an outcome. */
export type ToolCallObserver = (record: ToolCallRecord, extra: { authInfo?: AuthInfo; sessionId?: string }) => void;

const ENDED_CONNECTION_MESSAGE = 'This connection has ended: it was revoked, has expired, or is no longer known. '
    + 'Send the request again, and you will be asked to sign in.';

/**
 * What a client reads once on connecting: what the server does, how to find and run its operations,
 * and the operations most tasks start from, named so the client can describe them without a search.
 */
const SERVER_INSTRUCTIONS = [
    "This MCP server wraps the PDF Generator API v4: generate PDF documents from templates, manage templates and workspaces, convert HTML or a URL to PDF, create e-invoices (UBL, CII, XRechnung, Factur-X), and work on PDFs: watermark, encrypt, optimize, add accessibility tags, fill form fields.",
    `Its operations are not tools of their own. Find the ones for a task with ${SEARCH_OPERATIONS}, which lists each match's ID, the tool that runs it and how many tokens describing it costs. Read the arguments of the ones you will run with ${DESCRIBE_OPERATION}, then run each with ${READ_OPERATION} if it only reads, ${CALL_OPERATION} if it creates or changes something, or ${DELETE_OPERATION} if it deletes something. An operation named here can be described without searching for it first.`,
    "To generate a document, list the templates with get_templates and run generate_document. A list returns at most 50 records a page: narrow it with its search and filters rather than reading every page. Run calls one after another, not at the same time: the API takes 2 requests a second, and a template takes one builder step at a time. To build or restyle a template step by step, or change a few of its components without resending it, read get_builder_guide, list the steps with list_builder_tools and apply them with run_builder_tool. To see how a template looks, saved or not, run preview_template: it shows up to 3 of its pages as images, free and stored nowhere; show_pdf_pages does the same for a PDF you already have. Don't generate a document just to look at it: generate_document uses credits. Ask for a document as a link (output url or viewer) only when the user wants a link: a link stores the document for 30 days.",
    "To read a template only for its structure, pass images: omit to get_template, get_template_version, get_template_library_item or get_template_library_items: every embedded image is replaced by a short marker naming its type and size. A saved template read that way is changed with run_builder_tool, which keeps its images; a definition that still carries a marker is refused wherever it is sent, so to base a new template on a library template, read that one with its images. To open several library templates, use get_template_library_items with up to 5 ids at once, with images: omit unless the images are needed. To size a text box, measure its text with measure_text, up to 20 texts at once: it returns the lines a text breaks into at a width and its height, as the PDF draws them, so the box is neither cut nor too tall. Take every fontFamily from list_fonts.",
    `The connection acts in the workspace the user chose when connecting, with the permissions they granted: ${SEARCH_OPERATIONS} finds only the operations those permissions allow.`,
].join(' ');

/**
 * Prompt definitions for guided workflows
 */
const prompts = [
    {
        name: "generate-pdf",
        description: "Fill a template with data, preview it, and generate the PDF document when it is wanted",
        arguments: [
            { name: "templateId", description: "The ID of the template to use for PDF generation", required: true },
            { name: "outputFormat", description: "Output of the document: base64 or file; url or viewer only for a link, which stores the document for 30 days. Given, the document is generated after the preview; left out, only when asked for.", required: false },
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
            instructions: SERVER_INSTRUCTIONS,
        }
    );

    // All five are listed whatever the grant: search finds only what the grant allows, and a run
    // outside it is answered with the step-up challenge that lets the user grant the permission.
    server.setRequestHandler('tools/list', async () => {
        const tools: Tool[] = Array.from(metaTools.values()).map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: simplifySchemaForOpenAI(tool.inputSchema),
            annotations: tool.annotations,
        }));
        return { tools };
    });

    server.setRequestHandler('tools/call', async (request: CallToolRequest, ctx: ServerContext): Promise<CallToolResult> => {
        const extra = { authInfo: ctx.http?.authInfo, sessionId: ctx.sessionId };
        const startedAt = performance.now();
        const { name: toolName, arguments: toolArgs } = request.params;
        const operation = operationOf(toolName, toolArgs);
        const builderTool = builderToolOf(toolName, toolArgs);
        const observe = (details: Omit<ToolCallRecord, 'tool' | 'operation' | 'builderTool' | 'durationMs'>) =>
            onToolCall?.({ tool: toolName, operation, builderTool, durationMs: elapsedSince(startedAt), ...details }, extra);
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

        if (!isRunTool(toolName)) {
            const unknown = unknownTool(toolName);
            log.warn(`Unknown tool requested: ${toolName}`);
            observe({ outcome: 'refused', refusal: unknown.refusal });
            return { content: [{ type: "text", text: `Error: ${unknown.message}` }], isError: true };
        }

        const run = resolveRun(toolName, toolArgs ?? {});

        if ('refusal' in run) {
            observe({ outcome: 'refused', refusal: run.refusal });
            return { content: [{ type: "text", text: `Error: ${run.message}` }], isError: true };
        }

        const operationName = run.operation.id;
        const operationArgs = run.args;
        const toolDefinition = run.operation.definition;
        const decision = mayCallTool(operationName, scopes, operationArgs);

        if (!decision.allowed && enforcement !== 'off') {
            log.warn(`Tool "${operationName}" needs scope "${decision.required}", which this token does not grant`);

            if (enforcement === 'enforce') {
                observe({ outcome: 'refused', refusal: 'insufficient_scope' });
                return {
                    content: [{ type: "text", text: `Error: ${notGrantedMessage(operationName, decision.required)}` }],
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
            const generate = args?.outputFormat
                ? `Then run generate_document with ${CALL_OPERATION}, with the template ID, the same data and output "${args.outputFormat}".`
                : `Run generate_document with ${CALL_OPERATION} only when I want the document itself, with the output I ask for.`;
            return {
                messages: [{
                    role: "user" as const,
                    content: { type: "text" as const, text: `Generate a PDF document using template ID ${templateId}. First run get_template_data with ${READ_OPERATION} and templateId ${templateId} to see the data fields the template uses. Then show the template filled with data for those fields: run preview_template with ${READ_OPERATION}, which shows up to 3 pages as images, free and stored nowhere. ${generate} ${DESCRIBE_OPERATION} shows the arguments of each.` }
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
                            ? `Convert the URL "${source}" to a PDF document: run convert_url_to_pdf with ${CALL_OPERATION}, with paper size "${paperSize}" and portrait orientation. ${DESCRIBE_OPERATION} shows its arguments.`
                            : `Convert the following HTML content to a PDF document: run convert_html_to_pdf with ${CALL_OPERATION}, with paper size "${paperSize}" and portrait orientation. ${DESCRIBE_OPERATION} shows its arguments.\n\n${source}`
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
                    content: { type: "text" as const, text: `Create an e-invoice in ${format} format. First run get_einvoice_schema with ${READ_OPERATION} to get the data structure it takes. Then run ${tool} with ${CALL_OPERATION} to create the e-invoice; ${DESCRIBE_OPERATION} shows its arguments.` }
                }]
            };
        }

        throw new Error(`Unknown prompt: ${name}`);
    });

    return server;
}
