/**
 * diagnose-proxy-wallets.ts
 *
 * Diagnoses the root cause of 0 WS detections.
 *
 * 1. Loads tracked wallets from ahf-copyTraders
 * 2. Resolves proxy wallet for each via Polymarket CLOB API
 * 3. Takes the most recent filled txHash from ahf-copyTrades
 * 4. Fetches the tx receipt, extracts OrderFilled maker/taker
 * 5. Shows whether the user wallet OR proxy wallet matches the on-chain event
 *
 * This confirms whether proxy wallet mismatch is the root cause.
 *
 * Usage: npx tsx scripts/diagnose-proxy-wallets.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';
import { ethers } from 'ethers';

const envCandidates = [
  resolve(__dirname, '../.env.polyagent'),
  resolve(__dirname, '../.env.poly-agent'),
  resolve(__dirname, '../.env.local'),
  resolve(__dirname, '../.env'),
  resolve(__dirname, '../../../.env.local'),
];
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); break; }
}

const MONGO_URI   = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME     = process.env.MONGODB_DB_NAME || 'yieldr';
const HTTP_URL    = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL)!
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const CLOB_BASE   = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const DATA_BASE   = process.env.DATA_API_BASE  || 'https://data-api.polymarket.com';

const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const BOTH = new Set([CTF_EXCHANGE.toLowerCase(), NEG_RISK_EXCHANGE.toLowerCase()]);

const ORDER_FILLED_IFACE = new ethers.utils.Interface([
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
]);

async function rpc(method: string, params: any[]): Promise<any> {
  const res  = await fetch(HTTP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function resolveProxyWallet(userWallet: string): Promise<string | null> {
  // Polymarket CLOB API: GET /proxy-wallets/{address}
  // Returns the proxy wallet address used on-chain for this user
  const url = `${CLOB_BASE}/proxy-wallets/${userWallet}`;
  try {
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    // Response shape: { address: "0x..." } or { proxy_wallet: "0x..." }
    return (data.address ?? data.proxy_wallet ?? data.proxyWallet ?? null) as string | null;
  } catch { return null; }
}

async function resolveProxyWalletFromDataAPI(userWallet: string): Promise<string | null> {
  // Fallback: Polymarket data API profile endpoint
  const url = `${DATA_BASE}/profile?user=${userWallet}`;
  try {
    const res  = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as any;
    return (data.proxy_wallet_address ?? data.proxyWalletAddress ?? data.proxy_wallet ?? null) as string | null;
  } catch { return null; }
}

async function run() {
  console.log('\n[diagnose-proxy-wallets] Starting diagnosis...\n');

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  // ── Step 1: Load tracked wallets ─────────────────────────────────────────
  const traders = await db.collection('ahf-copyTraders')
    .find({ active: true })
    .project({ wallet: 1, label: 1 })
    .toArray();

  console.log(`Tracked traders (${traders.length}):`);
  for (const t of traders) {
    console.log(`  ${t.label}: ${t.wallet}`);
  }
  console.log('');

  // ── Step 2: Resolve proxy wallets ─────────────────────────────────────────
  console.log('Resolving proxy wallets via CLOB API...\n');
  const proxyMap = new Map<string, string | null>();

  for (const t of traders) {
    const wallet = (t.wallet as string).toLowerCase();
    let proxy = await resolveProxyWallet(wallet);
    if (!proxy) {
      console.log(`  ${t.label}: CLOB proxy-wallets endpoint returned nothing — trying data API...`);
      proxy = await resolveProxyWalletFromDataAPI(wallet);
    }
    proxyMap.set(wallet, proxy);

    const match = proxy ? `proxy → ${proxy}` : 'NO PROXY FOUND';
    console.log(`  ${t.label} (${wallet.slice(0, 10)}...) → ${match}`);
  }

  // ── Step 3: Get recent filled txHash from ahf-copyTrades ─────────────────
  console.log('\nLooking up recent filled trade txHash...');
  const recentFill = await db.collection('ahf-copyTrades').findOne(
    { status: 'FILLED', txHash: { $exists: true, $nin: [null, ''] } },
    { sort: { updatedAt: -1 }, projection: { txHash: 1, sourceWallet: 1, traderLabel: 1 } }
  );

  await client.close();

  if (!recentFill?.txHash) {
    console.log('  No filled trades found in DB.');
    return;
  }

  const txHash      = recentFill.txHash as string;
  const traderLabel = recentFill.traderLabel as string;
  const dbWallet    = (recentFill.sourceWallet as string).toLowerCase();
  const dbProxy     = proxyMap.get(dbWallet);

  console.log(`  Using: ${txHash}`);
  console.log(`  Trader: ${traderLabel} (wallet=${dbWallet.slice(0, 10)}...)\n`);

  // ── Step 4: Fetch receipt and extract maker/taker ─────────────────────────
  console.log('Fetching tx receipt from Polygon...');
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) {
    console.log('  Receipt not found.');
    return;
  }

  const logs: any[] = receipt.logs ?? [];
  const exchangeLogs = logs.filter((l: any) => BOTH.has(l.address?.toLowerCase()));

  if (exchangeLogs.length === 0) {
    console.log('  No OrderFilled logs found in this receipt.');
    return;
  }

  console.log(`  Found ${exchangeLogs.length} Polymarket log(s)\n`);

  for (const log of exchangeLogs) {
    const contract = log.address.toLowerCase() === CTF_EXCHANGE.toLowerCase() ? 'CTF_EXCHANGE' : 'NEG_RISK_EXCHANGE';
    let maker: string, taker: string;
    try {
      const parsed = ORDER_FILLED_IFACE.parseLog({ topics: log.topics, data: log.data });
      maker = (parsed.args.maker as string).toLowerCase();
      taker = (parsed.args.taker as string).toLowerCase();
    } catch {
      const maker_raw = log.topics[2];
      const taker_raw = log.topics[3];
      maker = '0x' + maker_raw.slice(26);
      taker = '0x' + taker_raw.slice(26);
    }

    const makerMatchesDbWallet  = maker === dbWallet;
    const takerMatchesDbWallet  = taker === dbWallet;
    const makerMatchesDbProxy   = dbProxy ? maker === dbProxy.toLowerCase() : false;
    const takerMatchesDbProxy   = dbProxy ? taker === dbProxy.toLowerCase() : false;
    const anyMatch = makerMatchesDbWallet || takerMatchesDbWallet || makerMatchesDbProxy || takerMatchesDbProxy;

    console.log(`Contract: ${contract}`);
    console.log(`  maker on-chain: ${maker}`);
    console.log(`  taker on-chain: ${taker}`);
    console.log(`  DB user wallet: ${dbWallet}`);
    console.log(`  DB proxy wallet: ${dbProxy ?? '(not resolved)'}`);
    console.log('');

    if (makerMatchesDbWallet || takerMatchesDbWallet) {
      console.log(`  ✅ USER WALLET MATCHES on-chain (${makerMatchesDbWallet ? 'maker' : 'taker'})`);
      console.log(`  → WS topic filter using user wallet SHOULD work.`);
      console.log(`  → Root cause is elsewhere (likely WS topic array format issue).`);
    } else if (makerMatchesDbProxy || takerMatchesDbProxy) {
      console.log(`  ✅ PROXY WALLET MATCHES on-chain (${makerMatchesDbProxy ? 'maker' : 'taker'})`);
      console.log(`  → CONFIRMED: DB stores user wallet, on-chain uses proxy wallet.`);
      console.log(`  → WS filter must use proxy wallet addresses, not user wallets.`);
    } else {
      console.log(`  ❌ NEITHER wallet matches on-chain`);
      if (dbProxy) {
        console.log(`  → Check if proxy wallet was resolved correctly.`);
      } else {
        console.log(`  → Proxy wallet lookup failed — try checking on Polygonscan manually.`);
        console.log(`  → maker: ${maker}`);
        console.log(`  → taker: ${taker}`);
      }
    }
    console.log('');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('─'.repeat(60));
  console.log('PROXY WALLET SUMMARY');
  console.log('─'.repeat(60));
  for (const t of traders) {
    const wallet = (t.wallet as string).toLowerCase();
    const proxy  = proxyMap.get(wallet);
    console.log(`${t.label}:`);
    console.log(`  user wallet:  ${wallet}`);
    console.log(`  proxy wallet: ${proxy ?? 'NOT RESOLVED'}`);
    console.log(`  → WS should filter by: ${proxy ?? 'UNKNOWN — needs investigation'}`);
    console.log('');
  }
}

run().catch(err => {
  console.error('[diagnose] Fatal:', err.message);
  process.exit(1);
});
