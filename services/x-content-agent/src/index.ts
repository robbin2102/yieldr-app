/**
 * X Content Agent Entry Point
 *
 * The official AI voice of @yieldrdotorg on X.
 * Generates and publishes content across 6 categories,
 * monitors replies and mentions, and engages with community.
 *
 * Uses Grok (xAI) for content generation.
 * Uses X API v2 (pay-per-use) for posting and monitoring.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });

import * as http from 'http';
import { connectDB, closeDB, getDB, COLLECTIONS } from './lib/db';
import { verifyCredentials } from './lib/x-client';
import { startScheduler } from './scheduler/calendar';
import { startReplyMonitor, stopReplyMonitor } from './replies/monitor';
import { CONFIG } from './config';

let server: http.Server | null = null;

function startHealthServer(): void {
  server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'x-content-agent',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/status') {
      try {
        const db = await getDB();
        const [postsToday, repliesTotal, mentionsTotal] = await Promise.all([
          db.collection(COLLECTIONS.X_POSTS).countDocuments({
            postedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          }),
          db.collection(COLLECTIONS.X_REPLIES).countDocuments(),
          db.collection(COLLECTIONS.X_MENTIONS).countDocuments(),
        ]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'running',
          postsToday,
          totalReplies: repliesTotal,
          totalMentions: mentionsTotal,
          dailyLimits: CONFIG.DAILY_LIMITS,
          timestamp: new Date().toISOString(),
        }));
      } catch (error: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.PORT, () => {
    console.log(`[Server] Health check running on port ${CONFIG.PORT}`);
  });
}

async function main() {
  console.log('');
  console.log('================================================================');
  console.log('           X CONTENT AGENT - @yieldrdotorg                      ');
  console.log('================================================================');
  console.log('');

  // Health server first
  startHealthServer();

  // Connect to MongoDB
  await connectDB();

  // Verify X API credentials
  console.log('[Init] Verifying X API credentials...');
  try {
    const user = await verifyCredentials();
    console.log(`[Init] Authenticated as @${user.username}`);
  } catch (error: any) {
    console.error(`[Init] X API auth failed: ${error.message}`);
    console.error('[Init] Content agent will run but cannot post. Fix X API credentials.');
  }

  // Start content scheduler
  startScheduler();

  // Start reply monitor
  startReplyMonitor();

  console.log('');
  console.log('================================================================');
  console.log('              AGENT RUNNING                                     ');
  console.log('================================================================');
  console.log(`  Health: http://localhost:${CONFIG.PORT}/health`);
  console.log(`  Status: http://localhost:${CONFIG.PORT}/status`);
  console.log(`  Model:  ${CONFIG.XAI_MODEL}`);
  console.log('================================================================');
  console.log('');
}

async function shutdown(signal: string) {
  console.log(`\n[Agent] Received ${signal}, shutting down...`);
  stopReplyMonitor();
  if (server) server.close();
  await closeDB();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => console.error('[Agent] Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('[Agent] Unhandled:', reason));

main().catch((error) => {
  console.error('[Agent] Fatal:', error);
  process.exit(1);
});
