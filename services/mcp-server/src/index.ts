/**
 * Yieldr MCP Server Entry Point
 *
 * Runs both:
 * 1. HTTP server for health checks (Railway requirement)
 * 2. MCP server for tool execution (via stdio or HTTP SSE)
 */

import express from 'express';
import { connectDB } from './db/index.js';
import { tools, toolMap } from './tools/index.js';
import { logger } from './utils/index.js';

const PORT = parseInt(process.env.PORT || '3000');

async function main() {
  // Connect to MongoDB
  await connectDB();

  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'yieldr-mcp-server' });
  });

  // List available tools
  app.get('/tools', (_req, res) => {
    res.json({
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
      })),
    });
  });

  // Execute tool endpoint (for HTTP-based MCP or direct API calls)
  app.post('/tools/:toolName', async (req, res) => {
    const { toolName } = req.params;
    const args = req.body;

    const tool = toolMap.get(toolName);
    if (!tool) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    try {
      logger.info(`Executing tool: ${toolName}`, args);
      const result = await tool.execute(args);
      res.json(result);
    } catch (error: unknown) {
      logger.error(`Tool ${toolName} failed:`, error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // MCP-compatible endpoint (for Claude integration)
  app.post('/mcp', async (req, res) => {
    const { method, params } = req.body;

    if (method === 'tools/list') {
      res.json({
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object',
            properties: {},
          },
        })),
      });
      return;
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params;
      const tool = toolMap.get(name);

      if (!tool) {
        res.status(404).json({ error: `Unknown tool: ${name}` });
        return;
      }

      try {
        const result = await tool.execute(args);
        res.json({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: message });
      }
      return;
    }

    res.status(400).json({ error: `Unknown method: ${method}` });
  });

  // Start HTTP server
  app.listen(PORT, () => {
    console.log('================================================================');
    console.log('           YIELDR MCP SERVER                                    ');
    console.log('================================================================');
    console.log(`  Health: http://localhost:${PORT}/health`);
    console.log(`  Tools:  http://localhost:${PORT}/tools`);
    console.log(`  MCP:    http://localhost:${PORT}/mcp`);
    console.log('================================================================');
    console.log('');
    console.log('Available Tools:');
    tools.forEach(t => {
      console.log(`  - ${t.name}: ${t.description.slice(0, 60)}...`);
    });
    console.log('');
  });
}

main().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
