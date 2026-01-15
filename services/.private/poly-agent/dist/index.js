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
const detector_1 = require("./modules/detector");
const executor_1 = require("./modules/executor");
const confirmer_1 = require("./modules/confirmer");
const reconciler_1 = require("./modules/reconciler");
const PolyAgentSlippage_1 = require("./db/models/PolyAgentSlippage");
/**
 * Poly-Agent v1 - Polymarket Copy Trading Agent
 *
 * Simplified architecture with only orderbook cache:
 * - Detector: Poll /activity every 3s
 * - Executor: Risk checks + FOK orders
 * - Confirmer: WSS User Channel for fills
 * - Reconciler: 60s position comparison
 */
async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    POLY-AGENT v1                               ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Target:     ${config_1.config.targetWallet}`);
    console.log(`Bot:        ${config_1.config.botWalletAddress}`);
    console.log(`Copy Ratio: ${(config_1.config.copyRatio * 100).toFixed(1)}%`);
    console.log(`Max Size:   $${config_1.config.maxPositionUsdc}`);
    console.log(`Min Size:   ${config_1.config.minTradeSize} shares`);
    console.log('═══════════════════════════════════════════════════════════════\n');
    // ═══════════════════════════════════════════════════════════════
    // 1. Connect to MongoDB
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Connecting to MongoDB...');
    await (0, connection_1.connectDB)();
    // ═══════════════════════════════════════════════════════════════
    // 2. Initialize CLOB client
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Initializing CLOB client...');
    const { client: clobClient, wallet } = await (0, client_1.createClobClient)();
    // ═══════════════════════════════════════════════════════════════
    // 3. Ensure allowances are set (one-time setup)
    // ═══════════════════════════════════════════════════════════════
    await (0, allowances_1.ensureAllowances)(config_1.config.botPrivateKey, config_1.config.polygonRpcUrl, config_1.config.chainId);
    // ═══════════════════════════════════════════════════════════════
    // 4. Initialize and connect Confirmer (WSS User Channel for fills)
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Connecting to User Channel...');
    const confirmer = new confirmer_1.Confirmer();
    await confirmer.connect();
    // ═══════════════════════════════════════════════════════════════
    // 5. Initialize Executor
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Initializing Executor...');
    const executor = new executor_1.Executor(clobClient);
    await executor.initialize();
    // ═══════════════════════════════════════════════════════════════
    // 6. Start Detector
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Starting Detector...');
    const detector = new detector_1.Detector();
    await detector.start();
    // ═══════════════════════════════════════════════════════════════
    // 7. Start Reconciler
    // ═══════════════════════════════════════════════════════════════
    console.log('[Main] Starting Reconciler...');
    const reconciler = new reconciler_1.Reconciler();
    reconciler.start();
    // ═══════════════════════════════════════════════════════════════
    // 8. Stats logger (every 30 seconds)
    // ═══════════════════════════════════════════════════════════════
    setInterval(async () => {
        try {
            const slippage = await PolyAgentSlippage_1.PolyAgentSlippage.findById('current').lean();
            if (slippage) {
                const buffer = slippage.bufferUsdc || 0;
                const trades = slippage.totalTrades || 0;
                const positive = slippage.totalPositiveSlippage || 0;
                const negative = slippage.totalNegativeSlippage || 0;
                console.log('\n[Stats] ────────────────────────────────────────');
                console.log(`  Trades: ${trades} (${positive} positive, ${negative} negative)`);
                console.log(`  Buffer: $${buffer.toFixed(2)}`);
                if (slippage.totalExpectedCost > 0) {
                    const bufferPercent = (buffer / slippage.totalExpectedCost) * 100;
                    console.log(`  Buffer %: ${bufferPercent.toFixed(2)}%`);
                }
                console.log('────────────────────────────────────────────────\n');
            }
            else {
                console.log('\n[Stats] No trades yet\n');
            }
        }
        catch (error) {
            console.error('[Stats] Error fetching stats:', error);
        }
    }, 30000);
    console.log('\n✅ Poly-Agent is running. Listening for trades...\n');
    // ═══════════════════════════════════════════════════════════════
    // 9. Graceful shutdown
    // ═══════════════════════════════════════════════════════════════
    process.on('SIGINT', async () => {
        console.log('\n\n[Main] Shutting down...');
        detector.stop();
        reconciler.stop();
        confirmer.disconnect();
        await mongoose_1.default.connection.close();
        console.log('[Main] Goodbye! 👋\n');
        process.exit(0);
    });
    process.on('SIGTERM', async () => {
        console.log('\n\n[Main] Received SIGTERM, shutting down...');
        detector.stop();
        reconciler.stop();
        confirmer.disconnect();
        await mongoose_1.default.connection.close();
        console.log('[Main] Shutdown complete\n');
        process.exit(0);
    });
}
// Start the agent
main().catch((error) => {
    console.error('\n[Main] Fatal error:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map