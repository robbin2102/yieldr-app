/**
 * Yieldr MCP Server Entry Point
 *
 * Runs both:
 * 1. HTTP server for health checks (Railway requirement)
 * 2. MCP server for tool execution (via stdio or HTTP SSE)
 */

// Load env vars: first from a local .env (if present), then from the monorepo root
// .env.local. On Railway, env vars are injected directly so these are no-ops.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import express from 'express';
import { connectDB } from './db/index.js';
import { tools, toolMap } from './tools/index.js';
import { logger } from './utils/index.js';

// MCP_SERVER_PORT lets you run locally alongside Next.js (which uses PORT=3000).
// On Railway each service gets its own PORT injected automatically, so this is local-only.
const PORT = parseInt(process.env.MCP_SERVER_PORT || process.env.PORT || '3001');

async function main() {
  const app = express();
  app.use(express.json());

  let dbConnected = false;

  // Health check endpoint - returns ok even before DB connects (Railway needs this fast)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'yieldr-mcp-server', db: dbConnected ? 'connected' : 'connecting' });
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
    const rawBody = req.body;

    // Unwrap legacy { params: { ... } } format sent by older scheduler versions
    const args = (
      rawBody !== null &&
      typeof rawBody === 'object' &&
      Object.keys(rawBody).length === 1 &&
      'params' in rawBody &&
      rawBody.params !== null &&
      typeof rawBody.params === 'object'
    ) ? rawBody.params : rawBody;

    const tool = toolMap.get(toolName);
    if (!tool) {
      res.status(404).json({ error: `Unknown tool: ${toolName}` });
      return;
    }

    // Validate input against the tool's Zod schema before executing
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      logger.warn(`Tool ${toolName} — invalid input:`, { received: args, errors: parsed.error.format() });
      res.status(400).json({
        error: 'Invalid tool input',
        received: args,
        details: parsed.error.format(),
      });
      return;
    }

    try {
      logger.info(`Executing tool: ${toolName}`, parsed.data);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await tool.execute(parsed.data as any);
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

  // Start HTTP server FIRST (Railway healthcheck needs port open immediately)
  app.listen(PORT, async () => {
    console.log('================================================================');
    console.log('           YIELDR MCP SERVER                                    ');
    console.log('================================================================');
    console.log(`  Health: http://localhost:${PORT}/health`);
    console.log(`  Tools:  http://localhost:${PORT}/tools`);
    console.log(`  MCP:    http://localhost:${PORT}/mcp`);
    console.log('================================================================');

    // Connect to MongoDB AFTER server is listening (so healthcheck passes)
    try {
      await connectDB();
      dbConnected = true;
      console.log('[DB] MongoDB connected successfully');
    } catch (error) {
      console.error('[DB] MongoDB connection failed:', error);
      // Don't exit - let healthcheck continue working
    }

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
