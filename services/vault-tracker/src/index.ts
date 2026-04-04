/**
 * Vault Tracker Service — entry point
 *
 * Starts:
 *  - HTTP health check server (required by Railway)
 *  - Activity poller (every 1 minute)
 *  - Profile cron (every 24 hours)
 */

import * as http from 'http';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env before anything else
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { CONFIG } from './config';
import { connectDB } from './db';
import { createLogger } from './utils/logger';
import { startActivityPoller } from './crons/activity-poller';
import { startProfileCron } from './crons/profile-cron';

const log = createLogger('VaultTracker');

// ── Health server ─────────────────────────────────────────────

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ts: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(CONFIG.PORT, () => {
    log.success(`Health server listening on port ${CONFIG.PORT}`);
  });
}

// ── Startup ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info('Starting vault-tracker service...');
  log.info(`  MONGODB_URI:       ${CONFIG.MONGODB_URI ? '[set]' : '[MISSING]'}`);
  log.info(`  Poll interval:     ${CONFIG.ACTIVITY_POLL_INTERVAL_MS / 1000}s`);
  log.info(`  Profile interval:  ${CONFIG.PROFILE_INTERVAL_MS / 3600000}h`);

  if (!CONFIG.MONGODB_URI) {
    log.error('MONGODB_URI is not set — exiting');
    process.exit(1);
  }

  await connectDB();
  startHealthServer();

  // Profile cron first — populates vaults collection fully before poller reads it.
  // Both run concurrently after their first cycle completes.
  await startProfileCron();
  await startActivityPoller();
}

main().catch(err => {
  log.error('Fatal startup error:', err.message);
  process.exit(1);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
