/**
 * probe-onchain.ts — On-chain detection lag probe (Option 1 benchmark)
 *
 * Subscribes to OrderFilled events on Polygon via QuickNode WebSocket.
 * Measures time from block.timestamp → event received by this process.
 * This bypasses Polymarket's API indexer entirely.
 *
 * Usage:
 *   tsx scripts/probe-onchain.ts              # filter by active trader wallets from DB
 *   tsx scripts/probe-onchain.ts --all        # log ALL OrderFilled events (immediate results)
 *
 * Requires POLYGON_WS_URL in .env.polyagent
 * Correlate with probe-api.ts output via tx= field (same txHash appears in both).
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, existsSync } from 'path';
import { existsSync as fsExists } from 'fs';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';

// ── Env loading (same priority order as config.ts) ───────────────────────────
const envCandidates = [
  resolve(__dirname, '../.env.polyagent'),
  resolve(__dirname, '../.env.poly-agent'),
  resolve(__dirname, '../.env.local'),
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../../.env.local'),
];
for (const p of envCandidates) {
  if (fsExists(p)) { dotenvConfig({ path: p }); break; }
}

// ── Config ───────────────────────────────────────────────────────────────────
const WS_URL    = process.env.POLYGON_WS_URL || (() => { throw new Error('POLYGON_WS_URL not set in .env.polyagent'); })();
const MONGO_URI = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME   = process.env.MONGODB_DB_NAME || 'yieldr';
const ALL_MODE  = process.argv.includes('--all');

// Polymarket exchange contracts on Polygon mainnet
const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

const ORDER_FILLED_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtUsdc(bn: ethers.BigNumber): string {
  return parseFloat(ethers.utils.formatUnits(bn, 6)).toFixed(2);
}

async function loadTrackedWallets(): Promise<Set<string>> {
  if (ALL_MODE) return new Set();
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const traders = await client.db(DB_NAME).collection('ahf-copyTraders')
    .find({ active: true }).project({ wallet: 1 }).toArray();
  await client.close();
  const set = new Set(traders.map((t: any) => (t.wallet as string).toLowerCase()));
  console.log(`[probe-onchain] Tracking ${set.size} active trader wallets from DB`);
  return set;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log(`[probe-onchain] Mode: ${ALL_MODE ? 'ALL trades' : 'tracked wallets only'}`);
  console.log(`[probe-onchain] WS: ${WS_URL.slice(0, 40)}...`);

  const trackedWallets = await loadTrackedWallets();

  const provider = new ethers.providers.WebSocketProvider(WS_URL);
  const iface    = new ethers.utils.Interface(ORDER_FILLED_ABI);
  const topic0   = iface.getEventTopic('OrderFilled');

  const filter = {
    address: [CTF_EXCHANGE, NEG_RISK_EXCHANGE],
    topics:  [topic0],
  };

  let totalEvents   = 0;
  let trackedEvents = 0;

  // Cache block timestamps to avoid duplicate getBlock RPC calls for fills in the same block
  const blockTsCache = new Map<number, number>(); // blockNumber → timestamp ms

  async function getBlockTs(blockNumber: number): Promise<number | null> {
    if (blockTsCache.has(blockNumber)) return blockTsCache.get(blockNumber)!;
    try {
      const block = await provider.getBlock(blockNumber);
      const ts = block.timestamp * 1000;
      blockTsCache.set(blockNumber, ts);
      // Keep cache small — only last 20 blocks (~40s of Polygon blocks)
      if (blockTsCache.size > 20) {
        const oldest = Math.min(...blockTsCache.keys());
        blockTsCache.delete(oldest);
      }
      return ts;
    } catch { return null; }
  }

  provider.on(filter, async (log: ethers.providers.Log) => {
    // Record received time immediately — before any async work
    const receivedAt = Date.now();
    totalEvents++;

    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const maker  = (parsed.args.maker as string).toLowerCase();
    const taker  = (parsed.args.taker as string).toLowerCase();

    const walletMatch = trackedWallets.has(maker) || trackedWallets.has(taker);
    if (!ALL_MODE && !walletMatch) return;

    trackedEvents++;

    // Determine USDC amount and trade direction
    // makerAssetId=0 → maker pays USDC (buying tokens); takerAssetId=0 → taker pays USDC (selling)
    const makerAssetId: ethers.BigNumber = parsed.args.makerAssetId;
    const makerPaysUsdc = makerAssetId.eq(0);
    const usdcAmt       = makerPaysUsdc ? fmtUsdc(parsed.args.makerAmountFilled) : fmtUsdc(parsed.args.takerAmountFilled);

    const wallet = walletMatch
      ? (trackedWallets.has(maker) ? maker : taker)
      : maker;  // --all mode: show maker
    const role = walletMatch
      ? (trackedWallets.has(maker) ? (makerPaysUsdc ? 'BUY' : 'SELL') : (makerPaysUsdc ? 'SELL' : 'BUY'))
      : (makerPaysUsdc ? 'BUY' : 'SELL');

    // Fetch block timestamp (cached — multiple fills in the same block reuse one RPC call)
    const blockTs = await getBlockTs(log.blockNumber);

    const lagMs  = blockTs !== null ? receivedAt - blockTs : null;
    const lagStr = lagMs  !== null ? `${lagMs}ms` : 'lag=?';
    const ts     = new Date(receivedAt).toISOString().slice(11, 23);
    const exchange = log.address.toLowerCase() === CTF_EXCHANGE.toLowerCase() ? 'CTF' : 'NEG';

    console.log(
      `[ON-CHAIN] ${ts} | ${role} $${usdcAmt} | wallet=${wallet.slice(0, 10)}... | ` +
      `lag=${lagStr} | block=${log.blockNumber} | blockTs=${blockTs ?? '?'} | receivedAt=${receivedAt} | ` +
      `exchange=${exchange} | tx=${log.transactionHash.slice(0, 14)}`
    );
  });

  // Heartbeat every 30s so you can confirm the WS is alive
  setInterval(() => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[ON-CHAIN] ${ts} ♥ alive | total events seen: ${totalEvents} | tracked: ${trackedEvents}`);
  }, 30_000);

  // Exit cleanly on WS close so the process can be restarted by a supervisor
  (provider as any)._websocket.on('close', (code: number, reason: string) => {
    console.error(`[probe-onchain] WebSocket closed (code=${code}) — exiting`);
    process.exit(1);
  });

  console.log(`[probe-onchain] Listening on CTF Exchange + NEG Risk Exchange...`);
  console.log(`[probe-onchain] Correlate with probe-api.ts using the tx= field\n`);
  console.log(`[probe-onchain] Press Ctrl+C to stop\n`);

  if (ALL_MODE) {
    console.log(`[probe-onchain] --all: showing ALL Polymarket fills (high volume expected)\n`);
  }
}

run().catch((err) => {
  console.error('[probe-onchain] Fatal:', err.message);
  process.exit(1);
});
