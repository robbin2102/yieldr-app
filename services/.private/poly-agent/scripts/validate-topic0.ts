/**
 * validate-topic0.ts — Confirm the correct OrderFilled event topic0 hash
 *
 * Fetches a recent filled trade txHash from MongoDB, calls eth_getTransactionReceipt,
 * and compares the actual on-chain topic0 against our computed value.
 * Run this once to verify/fix the event signature before running probe-onchain.
 *
 * Usage: npx tsx scripts/validate-topic0.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { ethers } from 'ethers';
import { MongoClient } from 'mongodb';

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

const MONGO_URI = (process.env.MONGO_PUBLIC_URL || process.env.MONGODB_URI)!;
const DB_NAME   = process.env.MONGODB_DB_NAME || 'yieldr';
const HTTP_URL  = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL)!
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

const CTF_EXCHANGE      = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const BOTH              = new Set([CTF_EXCHANGE.toLowerCase(), NEG_RISK_EXCHANGE.toLowerCase()]);

// What we currently compute as the OrderFilled topic
const COMPUTED_TOPIC0 = ethers.utils.id(
  'OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)'
);

async function rpc(method: string, params: any[]): Promise<any> {
  const res  = await fetch(HTTP_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function run() {
  console.log(`\n[validate-topic0] Computed topic0: ${COMPUTED_TOPIC0}`);
  console.log(`[validate-topic0] (from "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)")\n`);

  // ── Step 1: get a recent filled txHash from MongoDB ───────────────────────
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const recentFill = await db.collection('ahf-copyTrades').findOne(
    { status: 'FILLED', txHash: { $exists: true, $nin: [null, ''] } },
    { sort: { updatedAt: -1 }, projection: { txHash: 1, conditionId: 1, side: 1 } }
  );

  await client.close();

  if (!recentFill?.txHash) {
    console.log('[validate-topic0] No filled trades with txHash found in DB.');
    console.log('[validate-topic0] Try running --debug mode on probe-onchain instead:');
    console.log('  npx tsx scripts/probe-onchain.ts --debug');
    return;
  }

  const txHash = recentFill.txHash as string;
  console.log(`[validate-topic0] Using txHash from DB: ${txHash}`);
  console.log(`[validate-topic0]   conditionId: ${recentFill.conditionId}`);
  console.log(`[validate-topic0]   side: ${recentFill.side}\n`);

  // ── Step 2: fetch receipt and inspect logs ────────────────────────────────
  const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!receipt) {
    console.log('[validate-topic0] Receipt not found (tx may be on a different chain or not yet indexed)');
    return;
  }

  const logs: any[] = receipt.logs ?? [];
  console.log(`[validate-topic0] Receipt has ${logs.length} log(s). Checking those from Polymarket contracts...\n`);

  let found = false;
  for (const log of logs) {
    if (!BOTH.has(log.address?.toLowerCase())) continue;
    found = true;

    const contract  = log.address.toLowerCase() === CTF_EXCHANGE.toLowerCase() ? 'CTF_EXCHANGE' : 'NEG_RISK_EXCHANGE';
    const topic0    = log.topics?.[0] ?? '(none)';
    const matches   = topic0.toLowerCase() === COMPUTED_TOPIC0.toLowerCase();

    console.log(`Contract:  ${contract} (${log.address})`);
    console.log(`topic0 on-chain:  ${topic0}`);
    console.log(`topic0 computed:  ${COMPUTED_TOPIC0}`);
    console.log(matches
      ? `✅  MATCH — event signature is correct`
      : `❌  MISMATCH — event signature is wrong`);

    if (!matches) {
      console.log(`\n[validate-topic0] The actual topic0 is: ${topic0}`);
      console.log(`[validate-topic0] Paste this in the probe-onchain issue so the correct ABI can be identified.`);
      // Show all topics for manual inspection
      console.log(`\nAll topics for this log:`);
      (log.topics ?? []).forEach((t: string, i: number) => console.log(`  [${i}] ${t}`));
    }
    console.log('');
  }

  if (!found) {
    console.log('[validate-topic0] No logs from CTF_EXCHANGE or NEG_RISK_EXCHANGE in this receipt.');
    console.log('[validate-topic0] The txHash in DB may be from a different contract (e.g. USDC approval).');
    console.log('[validate-topic0] Try checking a different recent trade or run --debug on probe-onchain.');
  }
}

run().catch(err => {
  console.error('[validate-topic0] Error:', err.message);
  process.exit(1);
});
