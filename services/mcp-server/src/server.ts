/**
 * MCP Server - Model Context Protocol implementation
 * Exposes tools for Claude to interact with DeFi protocols
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { tools, toolMap } from './tools/index.js';
import { connectDB } from './db/index.js';
import { logger } from './utils/index.js';

export async function createMCPServer(): Promise<Server> {
  // Connect to MongoDB first
  await connectDB();

  const server = new Server(
    {
      name: 'yieldr-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(tool.inputSchema.shape).map(([key, value]) => {
              const zodType = value as { _def: { typeName: string; description?: string } };
              return [key, {
                type: getJsonType(zodType._def.typeName),
                description: zodType._def.description || '',
              }];
            })
          ),
        },
      })),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = toolMap.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      logger.info(`Executing tool: ${name}`, args);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await tool.execute(args as any);
      logger.info(`Tool ${name} completed successfully`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error(`Tool ${name} failed:`, error);
      throw error;
    }
  });

  return server;
}

// Helper to convert Zod types to JSON Schema types
function getJsonType(zodType: string): string {
  const typeMap: Record<string, string> = {
    ZodString: 'string',
    ZodNumber: 'number',
    ZodBoolean: 'boolean',
    ZodArray: 'array',
    ZodObject: 'object',
    ZodEnum: 'string',
    ZodOptional: 'string',
  };
  return typeMap[zodType] || 'string';
}

// Start server with stdio transport (for MCP)
export async function startMCPServer(): Promise<void> {
  const server = await createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP Server started with stdio transport');
}
