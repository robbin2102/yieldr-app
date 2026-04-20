/**
 * Trader Ranking Pipeline Service — Entry Point
 *
 * Standalone service that runs the 5-step trader profiling pipeline on a 24h schedule.
 * Deployed separately from the copy-trading bot (src/index.ts).
 *
 * Pipeline:
 *   fetch-leaderboard → find-consistent-traders → bulk-profile-ahf → edge-ranked-traders
 *   → materialize (HC trades + open positions)
 *
 * Also runs a market indexer (24h) to keep polyMarkets collection fresh.
 *
 * Health endpoints:
 *   GET /health  — liveness check
 *   GET /status  — pipeline + market indexer status
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env before anything else — same priority order as the trading bot
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../env.polyagent') });

import * as http from 'http';
import { spawn } from 'child_process';
import { connectPipelineDB, closePipelineDB } from './pipeline/db';
import { startMarketIndexer, stopMarketIndexer, getMarketIndexerStatus } from './pipeline/market-indexer';
import { startPipeline, stopPipeline, getPipelineStatus } from './pipeline/runner';
import { startAllocationChecker, stopAllocationChecker, getAllocationCheckerStatus } from './pipeline/allocation-checker';
import { PIPELINE_CONFIG } from './pipeline/pipeline-config';

let server: http.Server | null = null;

// ── Admin script runner (sell / redeem) ────────────────────────────────────────
// __dirname = dist/ (compiled) or src/ (tsx dev). Poly-agent root is one up.
const POLY_AGENT_DIR = path.resolve(__dirname, '..');

const POLY_AGENT_OWNED_KEYS = [
  'BOT_WALLET_ADDRESS', 'BOT_PRIVATE_KEY',
  'POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_PASSPHRASE',
  'POLYGON_RPC_URL', 'CHAIN_ID',
  'DATA_API_BASE', 'CLOB_API_BASE', 'WSS_MARKET', 'WSS_USER',
];
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of POLY_AGENT_OWNED_KEYS) delete env[k];
  return env;
}

function runAdminScript(args: string[], tag: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    console.log(`${tag} spawn: npx tsx ${args.join(' ')}`);
    const startMs = Date.now();
    // On Railway, env vars are injected directly — pass process.env as-is.
    // cleanEnv() is only needed on localhost to avoid Next.js placeholder overrides.
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
  const auth = req.headers['authorization'] ?? '';
  return auth === `Bearer ${token}`;
}

// ── HTTP server ────────────────────────────────────────────────────────────────
function startHealthServer(): void {
  server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:    'ok',
        service:   'poly-agent-pipeline',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    if (req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:   'running',
        monitors: {
          marketIndexer:      getMarketIndexerStatus(),
          pipeline:           getPipelineStatus(),
          allocationChecker:  getAllocationCheckerStatus(),
        },
        intervals: {
          marketIndex:        `${PIPELINE_CONFIG.INTERVALS.MARKET_INDEX / 3_600_000}h`,
          pipeline:           `${PIPELINE_CONFIG.INTERVALS.PIPELINE / 3_600_000}h`,
          analyzeAllocations: `${PIPELINE_CONFIG.INTERVALS.ANALYZE_ALLOCATIONS / 3_600_000}h`,
        },
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

    // POST /admin/sell-position
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

    // POST /admin/redeem-all
    if (req.method === 'POST' && req.url === '/admin/redeem-all') {
      if (!checkAuth(req)) return json(res, 401, { success: false, error: 'Unauthorized' });
      const scriptPath = path.join(POLY_AGENT_DIR, 'redeem-positions.ts');
      const result = await runAdminScript([scriptPath, '--execute'], '[redeem-all]');
      return json(res, 200, { success: result.exitCode === 0, ...result });
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PIPELINE_CONFIG.PORT, () => {
    console.log(`[Pipeline] Health check running on port ${PIPELINE_CONFIG.PORT}`);
  });
}

async function main() {
  console.log('');
  console.log('================================================================');
  console.log('           TRADER RANKING PIPELINE SERVICE                      ');
  console.log('================================================================');
  console.log('');

  // Health server first (Railway needs fast response)
  startHealthServer();

  // Connect to MongoDB (needed for materialization step)
  await connectPipelineDB();

  // Market indexer starts immediately
  startMarketIndexer();

  // Pipeline: check last-run time in MongoDB — skips if ran within 24h on redeploy.
  // 1-minute delay so market indexer gets a head start on first-ever run.
  setTimeout(() => {
    startPipeline(PIPELINE_CONFIG.INTERVALS.PIPELINE).catch(
      err => console.error('[Pipeline] startPipeline error:', err),
    );
  }, 1 * 60 * 1000);

  // Allocation checker: check last-run time in MongoDB — respects 4h cadence across restarts.
  // 2-minute delay to ensure DB is ready.
  setTimeout(() => {
    startAllocationChecker(PIPELINE_CONFIG.INTERVALS.ANALYZE_ALLOCATIONS).catch(
      err => console.error('[Pipeline] startAllocationChecker error:', err),
    );
  }, 2 * 60 * 1000);

  console.log('');
  console.log('================================================================');
  console.log('              SERVICE RUNNING                                   ');
  console.log('================================================================');
  console.log(`  Health:     http://localhost:${PIPELINE_CONFIG.PORT}/health`);
  console.log(`  Status:     http://localhost:${PIPELINE_CONFIG.PORT}/status`);
  console.log(`  Market:     every ${PIPELINE_CONFIG.INTERVALS.MARKET_INDEX / 3_600_000}h (starts immediately)`);
  console.log(`  Pipeline:   every ${PIPELINE_CONFIG.INTERVALS.PIPELINE / 3_600_000}h (starts in 5m)`);
  console.log(`  Alloc:      every ${PIPELINE_CONFIG.INTERVALS.ANALYZE_ALLOCATIONS / 3_600_000}h (starts in 10m)`);
  console.log('================================================================');
  console.log('');
}

async function shutdown(signal: string) {
  console.log(`\n[Pipeline] Received ${signal}, shutting down...`);
  stopMarketIndexer();
  stopPipeline();
  stopAllocationChecker();
  if (server) server.close();
  await closePipelineDB();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (error)  => console.error('[Pipeline] Uncaught:', error));
process.on('unhandledRejection', (reason) => console.error('[Pipeline] Unhandled:', reason));

main().catch((error) => {
  console.error('[Pipeline] Fatal:', error);
  process.exit(1);
});
