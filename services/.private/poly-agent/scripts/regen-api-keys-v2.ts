/**
 * regen-api-keys-v2.ts
 *
 * Generates (or derives) CLOBv2 API credentials for the bot wallet.
 *
 * V1 API keys are NOT compatible with the v2 CLOB endpoint.
 * This script calls createOrDeriveApiKey() — if a key already exists for this
 * wallet+nonce it returns the existing one, otherwise creates a new one.
 *
 * Output: prints key / secret / passphrase to stdout.
 * Copy them into .env.polyagent as CLOB_V2_API_KEY / _SECRET / _PASSPHRASE.
 *
 * Usage: npx tsx scripts/regen-api-keys-v2.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { ClobClient, Chain } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

// ── Env loading ───────────────────────────────────────────────────────────────
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

const PRIVATE_KEY  = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const POLYGON_RPC  = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const CLOB_HOST    = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';

if (!PRIVATE_KEY) {
  console.error('[regen-keys] Missing PRIVATE_KEY / BOT_PRIVATE_KEY');
  process.exit(1);
}
if (!POLYGON_RPC) {
  console.error('[regen-keys] Missing POLYGON_WS_URL / POLYGON_RPC_URL');
  process.exit(1);
}

async function main() {
  const account    = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const walletClient = createWalletClient({
    account, chain: polygon, transport: http(POLYGON_RPC),
  });

  // No creds — this client is used only for the key generation L1 auth flow
  const client = new ClobClient({
    host:   CLOB_HOST,
    chain:  Chain.POLYGON,
    signer: walletClient as any,
    throwOnError: true,
  });

  console.log(`\n[regen-keys] Wallet: ${account.address}`);
  console.log(`[regen-keys] CLOB host: ${CLOB_HOST}`);
  console.log('[regen-keys] Calling createOrDeriveApiKey...\n');

  const apiCreds = await (client as any).createOrDeriveApiKey();

  if (!apiCreds?.key) {
    console.error('[regen-keys] Unexpected response:', apiCreds);
    process.exit(1);
  }

  console.log('─'.repeat(60));
  console.log('CLOBv2 API credentials');
  console.log('─'.repeat(60));
  console.log(`CLOB_V2_API_KEY=${apiCreds.key}`);
  console.log(`CLOB_V2_API_SECRET=${apiCreds.secret}`);
  console.log(`CLOB_V2_PASSPHRASE=${apiCreds.passphrase}`);
  console.log('─'.repeat(60));
  console.log('\nCopy these into .env.polyagent (replace old CLOB_API_KEY / _SECRET / _PASSPHRASE entries).\n');
}

main().catch(err => {
  console.error('[regen-keys] Fatal:', err.message ?? err);
  process.exit(1);
});
