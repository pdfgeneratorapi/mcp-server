import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
            log.warn(`Unknown tool requested: ${toolName}`);
            return { content: [{ type: "text", text: `Error: Unknown tool requested: ${toolName}` }], isError: true };
        }
        return await executeApiTool(toolName, toolDefinition, toolArgs ?? {}, bearerToken);
    });

    return server;
}
