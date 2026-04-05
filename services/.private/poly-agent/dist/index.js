"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
const config_1 = require("./config");
const connection_1 = require("./db/connection");
const client_1 = require("./clob/client");
const allowances_1 = require("./clob/allowances");
const multiDetector_1 = require("./modules/multiDetector");
const gttExecutor_1 = require("./modules/gttExecutor");
const confirmer_1 = require("./modules/confirmer");
const executionTracker_1 = require("./modules/executionTracker");
const CopyTrader_1 = require("./db/models/CopyTrader");
/**
 * Poly-Agent v3 — Multi-trader copy trading
 *
 * What's new vs v2:
 *   - Tracks N traders from ahf-copyTraders (add traders without restart)
 *   - GTT limit orders (best_ask - 1.5¢) with progressive retry vs FAK
 *   - Proportional bet sizing above avgBet (skip probe bets below avg)
 *   - Per-trader allocation cap only (no daily cap)
 *   - Full execution timeline: discovery → submission → fill latency
 *   - All skip reasons logged to MongoDB (BELOW_AVG, ALLOCATION_FULL, etc.)
 *   - Per-trader detectorIntervalMs — change poll rate per wallet in DB
 */
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    POLY-AGENT v3                               ');
    console.log('                    Multi-Trader Copy System                    ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Bot:           ${config_1.config.botWalletAddress}`);
    console.log(`Poll interval: ${config_1.config.detectorIntervalMs / 1000}s (per-trader overrides in DB)`);
    console.log(`GTT expiry:    ${config_1.config.gttExpirySeconds}s  |  retries: ${config_1.config.maxOrderRetries}`);
    console.log(`Max bet cap:   $${config_1.config.maxPositionUsdc}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
    // ── 1. MongoDB ─────────────────────────────────────────────────────────────
    await (0, connection_1.connectDB)();
    // Guard: don't query until Mongoose is fully ready (matters after retry)
    await (0, connection_1.waitForConnection)();
    const traders = await CopyTrader_1.CopyTrader.find({ active: true }).lean();
    if (traders.length === 0) {
        console.error('[Main] No active traders in ahf-copyTraders. Run the seeder first:');
        console.error('  npx tsx scripts/ai-hedge-fund/seed-copy-traders.ts');
        process.exit(1);
    }
    console.log(`[Main] Active traders: ${traders.length}`);
    let totalAlloc = 0;
    for (const t of traders) {
        const remaining = t.allocationUsdc - t.spentUsdc;
        console.log(`  ${t.label.padEnd(24)} alloc=$${t.allocationUsdc}  spent=$${t.spentUsdc.toFixed(2)}  remaining=$${remaining.toFixed(2)}  active=${t.active}`);
        totalAlloc += t.allocationUsdc;
    }
    console.log(`  Total allocation: $${totalAlloc}\n`);
    // ── 2. CLOB client ─────────────────────────────────────────────────────────
    console.log('[Main] Initializing CLOB client...');
    const { client: clobClient } = await (0, client_1.createClobClient)();
    // ── 3. Token approvals (one-time on-chain setup) ──────────────────────────
    await (0, allowances_1.ensureAllowances)(config_1.config.botPrivateKey, config_1.config.polygonRpcUrl, config_1.config.chainId);
    // ── 4. Confirmer (WebSocket User Channel — receives fill push events) ────────
    // Clear any EXECUTING docs left over from a previous run — they'll never
    // receive fill events on this new WS session and would block allocation.
    await confirmer_1.Confirmer.clearStaleExecutingDocs();
    console.log('[Main] Connecting Confirmer to WebSocket User Channel...');
    const confirmer = new confirmer_1.Confirmer();
    await confirmer.connect();
    confirmer.startStuckOrderScan(); // catch fills missed by WebSocket mid-session
    // ── 5. GTT Executor (places orders, hands off to Confirmer for fills) ────────
    console.log('[Main] Starting GTT Executor...');
    new gttExecutor_1.GTTExecutor(clobClient);
    // ── 6. Multi-trader Detector ───────────────────────────────────────────────
    console.log('[Main] Starting Multi-Trader Detector...');
    const detector = new multiDetector_1.MultiDetector();
    await detector.start();
    // ── 7. Execution Tracker (prints reports on interval) ─────────────────────
    console.log('[Main] Starting Execution Tracker...');
    const tracker = new executionTracker_1.ExecutionTracker(config_1.config.reportIntervalMs);
    tracker.start();
    console.log('\n✅ Poly-Agent v3 running.');
    console.log('   Per-poll heartbeat:  every 60s per trader (👁 = quiet, 🔔 = activity)');
    console.log('   Trade detected:      ━━━ immediate log with doc ID');
    console.log('   Execution summary:   printed every 10m\n');
    // ── Graceful shutdown ──────────────────────────────────────────────────────
    const shutdown = async (signal) => {
        console.log(`\n[Main] ${signal} — shutting down...`);
        detector.stop();
        tracker.stop();
        confirmer.disconnect();
        // Force exit after 5s if shutdown hangs (e.g. slow DB query on final report)
        const forceExit = setTimeout(() => {
            console.log('[Main] Force exit after 5s timeout.');
            process.exit(0);
        }, 5000);
        forceExit.unref(); // don't let this timer itself keep the process alive
        try {
            await tracker.printAllReports(24);
        }
        catch { /* ignore if DB already closing */ }
        await mongoose_1.default.connection.close();
        console.log('[Main] Shutdown complete.\n');
        process.exit(0);
    };
    // process.once — prevents double-fire if Ctrl+C is pressed twice
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch(err => {
    console.error('\n[Main] Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map