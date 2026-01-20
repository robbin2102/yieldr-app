import mongoose from 'mongoose';
import { config } from './config';
import { connectDB } from './db/connection';
import { createClobClient } from './clob/client';
import { ensureAllowances } from './clob/allowances';
import { orderbookCache } from './state/orderbookCache';
import { Detector } from './modules/detector';
import { Executor } from './modules/executor';
import { Confirmer } from './modules/confirmer';
import { Reconciler } from './modules/reconciler';
import { InitialCopier } from './modules/initialCopier';
import { Metrics } from './modules/metrics';
import { PolyAgentSlippage } from './db/models/PolyAgentSlippage';

/**
 * Poly-Agent v2 - Polymarket Copy Trading Agent
 *
 * Features:
 * - InitialCopier: Sync existing positions on startup with drift check
 * - Detector: Poll /activity every 30s for new trades
 * - Executor: FAK orders with retry for 100% fills
 * - Confirmer: WSS User Channel for fills
 * - Reconciler: 60s position comparison
 * - Metrics: Dashboard with PnL and drift tracking
 *
 * Drift thresholds:
 * - New positions: copy if drift < 10%
 * - Existing positions: sync if drift < 20%
 * - Underwater positions: skip if drift < -10%
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    POLY-AGENT v2                               ');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Target:      ${config.targetWallet}`);
  console.log(`Bot:         ${config.botWalletAddress}`);
  console.log(`Allocation:  $${config.maxAllocationUsdc}`);
  console.log(`Drift (new): ${config.driftThresholdNew}%`);
  console.log(`Drift (sync): ${config.driftThresholdExisting}%`);
  console.log(`Poll:        ${config.detectorIntervalMs / 1000}s`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ═══════════════════════════════════════════════════════════════
  // 1. Connect to MongoDB
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Connecting to MongoDB...');
  await connectDB();

  // ═══════════════════════════════════════════════════════════════
  // 2. Initialize CLOB client
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Initializing CLOB client...');
  const { client: clobClient, wallet } = await createClobClient();

  // ═══════════════════════════════════════════════════════════════
  // 3. Ensure allowances are set (one-time setup)
  // ═══════════════════════════════════════════════════════════════
  await ensureAllowances(config.botPrivateKey, config.polygonRpcUrl, config.chainId);

  // ═══════════════════════════════════════════════════════════════
  // 4. Initialize and connect Confirmer (WSS User Channel for fills)
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Connecting to User Channel...');
  const confirmer = new Confirmer();
  await confirmer.connect();

  // ═══════════════════════════════════════════════════════════════
  // 5. Initialize Executor
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Initializing Executor...');
  const executor = new Executor(clobClient);
  await executor.initialize();

  // ═══════════════════════════════════════════════════════════════
  // 6. Start Detector
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Starting Detector...');
  const detector = new Detector();
  await detector.start();

  // ═══════════════════════════════════════════════════════════════
  // 7. Start Reconciler
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Starting Reconciler...');
  const reconciler = new Reconciler();
  reconciler.start();

  // ═══════════════════════════════════════════════════════════════
  // 8. Initialize Metrics
  // ═══════════════════════════════════════════════════════════════
  console.log('[Main] Initializing Metrics...');
  const metrics = new Metrics();
  await metrics.initialize();

  // ═══════════════════════════════════════════════════════════════
  // 9. Run Initial Position Sync (if enabled)
  // ═══════════════════════════════════════════════════════════════
  if (config.enableInitialSync) {
    console.log('[Main] Running initial position sync...');
    const initialCopier = new InitialCopier(clobClient);
    await initialCopier.syncPositions();
  } else {
    console.log('[Main] Initial sync disabled, skipping...');
  }

  console.log('\n✅ Poly-Agent v2 is running. Listening for trades...\n');

  // Log initial metrics
  await metrics.logSummary();

  // ═══════════════════════════════════════════════════════════════
  // 10. Graceful shutdown
  // ═══════════════════════════════════════════════════════════════
  process.on('SIGINT', async () => {
    console.log('\n\n[Main] Shutting down...');

    detector.stop();
    reconciler.stop();
    confirmer.disconnect();
    await metrics.shutdown();

    await mongoose.connection.close();

    console.log('[Main] Goodbye! 👋\n');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n\n[Main] Received SIGTERM, shutting down...');

    detector.stop();
    reconciler.stop();
    confirmer.disconnect();
    await metrics.shutdown();

    await mongoose.connection.close();

    console.log('[Main] Shutdown complete\n');
    process.exit(0);
  });
}

// Start the agent
main().catch((error) => {
  console.error('\n[Main] Fatal error:', error);
  process.exit(1);
});
