import mongoose from 'mongoose';
import * as http from 'http';
import { spawn } from 'child_process';
import * as path from 'path';
import { config } from './config';
import { connectDB, waitForConnection } from './db/connection';
import { createClobClient } from './clob/client';
import { ensureAllowances } from './clob/allowances';
import { MultiDetector } from './modules/multiDetector';
import { GTTExecutor } from './modules/gttExecutor';
import { Confirmer } from './modules/confirmer';
import { ExecutionTracker } from './modules/executionTracker';
import { CopyTrader } from './db/models/CopyTrader';

// ── Admin HTTP server (health + sell/redeem endpoints) ─────────────────────────
// __dirname = dist/ (compiled). Poly-agent root is one up.
const POLY_AGENT_DIR = path.resolve(__dirname, '..');
const BOT_PORT = parseInt(process.env.PORT || '3001');

const POLY_AGENT_OWNED_KEYS = [
  'BOT_WALLET_ADDRESS', 'BOT_PRIVATE_KEY',
  'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_PASSPHRASE',
  'POLYGON_RPC_URL', 'CHAIN_ID',
  'DATA_API_BASE', 'CLOB_API_BASE', 'WSS_MARKET', 'WSS_USER',
];

function runAdminScript(args: string[], tag: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    console.log(`${tag} spawn: npx tsx ${args.join(' ')}`);
    const startMs = Date.now();
    const proc = spawn('npx', ['tsx', ...args], { cwd: POLY_AGENT_DIR, env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d: Buffer) => { const s = d.toString(); stdout += s; process.stdout.write(`${tag} ${s}`); });
    proc.stderr.on('data', (d: Buffer) => { const s = d.toString(); stderr += s; process.stderr.write(`${tag} ${s}`); });
    proc.on('close', (code: number | null) => {
      console.log(`${tag} exit=${code} in ${((Date.now() - startMs) / 1000).toFixed(1)}s`);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err: Error) => {
      console.error(`${tag} spawn error:`, err.message);
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res: http.ServerResponse, status: number, data: object): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function checkAuth(req: http.IncomingMessage): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  return (req.headers['authorization'] ?? '') === `Bearer ${token}`;
}

function startBotHealthServer(): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'poly-agent-bot', timestamp: new Date().toISOString() }));
      return;
    }

    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

    if (req.method === 'POST' && req.url === '/admin/sell-position') {
      if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
      let body: any;
      try { body = await parseBody(req); } catch { return json(res, 400, { success: false, error: 'Invalid JSON' }); }
      const { tokenId, size } = body as { tokenId?: string; size?: number };
      if (!tokenId || typeof tokenId !== 'string' || !/^\d+$/.test(tokenId))
        return json(res, 400, { success: false, error: 'tokenId (numeric string) required' });
      const sizeNum = Number(size);
      if (!Number.isFinite(sizeNum) || sizeNum <= 0)
        return json(res, 400, { success: false, error: 'size (positive number) required' });
      const scriptPath = path.join(POLY_AGENT_DIR, 'sell-position.ts');
      const result = await runAdminScript([scriptPath, '--token', tokenId, '--size', String(sizeNum)], '[sell-position]');
      return json(res, 200, { success: result.exitCode === 0, ...result });
    }

    if (req.method === 'POST' && req.url === '/admin/redeem-all') {
      if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
      const scriptPath = path.join(POLY_AGENT_DIR, 'redeem-positions.ts');
      const result = await runAdminScript([scriptPath, '--execute'], '[redeem-all]');
      return json(res, 200, { success: result.exitCode === 0, ...result });
    }

    res.writeHead(404); res.end('Not found');
  });

  server.listen(BOT_PORT, '0.0.0.0', () => {
    console.log(`[Bot] Health server on port ${BOT_PORT}`);
  });
}

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
  console.log(`Bot:           ${config.botWalletAddress}`);
  console.log(`Poll interval: ${config.detectorIntervalMs / 1000}s (per-trader overrides in DB)`);
  console.log(`GTT expiry:    ${config.gttExpirySeconds}s  |  retries: ${config.maxOrderRetries}`);
  console.log(`Max bet cap:   $${config.maxPositionUsdc}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── 1. MongoDB ─────────────────────────────────────────────────────────────
  await connectDB();

  // Guard: don't query until Mongoose is fully ready (matters after retry)
  await waitForConnection();

  const traders = await CopyTrader.find({ active: true }).lean();
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
  const { client: clobClient } = await createClobClient();

  // ── 3. Token approvals (one-time on-chain setup) ──────────────────────────
  await ensureAllowances(config.botPrivateKey, config.polygonRpcUrl, config.chainId);

  // ── 4. Confirmer (WebSocket User Channel — receives fill push events) ────────
  // Clear any EXECUTING docs left over from a previous run — they'll never
  // receive fill events on this new WS session and would block allocation.
  await Confirmer.clearStaleExecutingDocs();

  console.log('[Main] Connecting Confirmer to WebSocket User Channel...');
  const confirmer = new Confirmer();
  await confirmer.connect();
  confirmer.startStuckOrderScan();       // catch fills missed by WebSocket mid-session
  confirmer.startGroupedTradeScanner();  // aggregate BELOW_AVG sub-orders into conviction trades (30m rolling)

  // ── 5. GTT Executor (places orders, hands off to Confirmer for fills) ────────
  console.log('[Main] Starting GTT Executor...');
  new GTTExecutor(clobClient);

  // Startup backfill AFTER GTTExecutor is registered — it listens for trade:detected
  await confirmer.runStartupScan();      // one-time 3h backfill for pre-restart accumulations

  // ── 6. Multi-trader Detector ───────────────────────────────────────────────
  console.log('[Main] Starting Multi-Trader Detector...');
  const detector = new MultiDetector();
  await detector.start();

  // ── 7. Execution Tracker (prints reports on interval) ─────────────────────
  console.log('[Main] Starting Execution Tracker...');
  const tracker = new ExecutionTracker(config.reportIntervalMs);
  tracker.start();

  console.log('\n✅ Poly-Agent v3 running.');
  console.log('   Per-poll heartbeat:  every 60s per trader (silent if no activity)');
  console.log('   Trade detected:      T6 BUY $4148 "title" lag 20s | ×1.3 avg $3200 → copy $7');
  console.log('   Execution summary:   printed every 10m\n');

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[Main] ${signal} — shutting down...`);
    detector.stop();
    tracker.stop();
    confirmer.disconnect();

    // Force exit after 5s if shutdown hangs (e.g. slow DB query on final report)
    const forceExit = setTimeout(() => {
      console.log('[Main] Force exit after 5s timeout.');
      process.exit(0);
    }, 5000);
    forceExit.unref();  // don't let this timer itself keep the process alive

    try { await tracker.printAllReports(24); } catch { /* ignore if DB already closing */ }
    await mongoose.connection.close();
    console.log('[Main] Shutdown complete.\n');
    process.exit(0);
  };

  // process.once — prevents double-fire if Ctrl+C is pressed twice
  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('\n[Main] Fatal error:', err?.message ?? err);
  process.exit(1);
});

// Catch unhandled promise rejections (e.g. DB query during network blip in a setInterval).
// Without this, Node.js 15+ crashes the process on any unhandled rejection.
// Logging the error here keeps the bot alive — Mongoose will reconnect automatically.
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message ?? String(reason);
  console.error(`[Main] ⚠️  Unhandled rejection (bot continues): ${msg}`);
});
