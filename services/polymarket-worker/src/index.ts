/**
 * Polymarket Worker Service
 *
 * Monitors tracked traders and provides real-time updates:
 * - Alert Monitor: Detects new trades every 10s
 * - Position Refresher: Updates prices every 60s
 * - Profile Refresher: Updates stats every 5 min
 * - WebSocket Server: Real-time updates to frontend
 */

import * as dotenv from 'dotenv';
import { connectDB, closeDB } from './lib/db';
import { wsManager } from './websocket/server';
import { startAlertMonitor, stopAlertMonitor } from './monitors/alert-monitor';
import { startPositionRefresher, stopPositionRefresher } from './monitors/position-refresher';
import { startProfileRefresher, stopProfileRefresher } from './monitors/profile-refresher';

// Load environment variables
dotenv.config();

const WS_PORT = parseInt(process.env.WS_PORT || '8080');

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           POLYMARKET COPY TRADING WORKER SERVICE              ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Connect to MongoDB
  await connectDB();

  // Start WebSocket server
  wsManager.start(WS_PORT);

  // Start all monitors
  startAlertMonitor();      // Every 10s
  startPositionRefresher(); // Every 60s
  startProfileRefresher();  // Every 5 min

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    WORKER RUNNING                             ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  WebSocket:  ws://localhost:${WS_PORT}`);
  console.log('  Monitors:   Alert (10s), Positions (60s), Profiles (5min)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Log status periodically
  setInterval(() => {
    const clients = wsManager.getClientCount();
    console.log(`[Status] ${new Date().toISOString()} - WS clients: ${clients}`);
  }, 60_000); // Every minute
}

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`\n[Worker] Received ${signal}, shutting down...`);

  stopAlertMonitor();
  stopPositionRefresher();
  stopProfileRefresher();
  wsManager.stop();
  await closeDB();

  console.log('[Worker] Goodbye!');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
});

// Start the worker
main().catch((error) => {
  console.error('[Worker] Fatal error:', error);
  process.exit(1);
});
