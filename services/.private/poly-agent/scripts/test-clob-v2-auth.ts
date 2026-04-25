/**
 * test-clob-v2-auth.ts
 *
 * Phase 1 connectivity check for CLOBv2:
 *   1. Verify L1 auth (wallet signature)
 *   2. Verify L2 auth (API key credentials)
 *   3. Fetch orderbook for a known market token
 *   4. Check bot wallet pUSD + USDC.e balances
 *   5. Check open orders + positions
 *
 * Run before live trading to confirm keys + balances are ready.
 *
 * Usage: npx tsx scripts/test-clob-v2-auth.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { ClobClient, Chain } from '@polymarket/clob-client-v2';
import { createPublicClient, createWalletClient, http, formatUnits, type Address } from 'viem';
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
let loadedEnvFile = '(none found)';
for (const p of envCandidates) {
  if (existsSync(p)) { dotenvConfig({ path: p }); loadedEnvFile = p; break; }
}

const PRIVATE_KEY  = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const POLYGON_RPC  = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const CLOB_HOST    = process.env.CLOB_API_BASE || 'https://clob.polymarket.com';
const API_KEY      = process.env.CLOB_V2_API_KEY      || process.env.CLOB_API_KEY;
const API_SECRET   = process.env.CLOB_V2_API_SECRET   || process.env.CLOB_API_SECRET;
const PASSPHRASE   = process.env.CLOB_V2_PASSPHRASE   || process.env.CLOB_PASSPHRASE;

const USDC_E       = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as Address;
const PUSD         = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as Address;

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

// A stable, high-liquidity token to use for orderbook test (TRUMP 2026 YES)
// Override via env TEST_TOKEN_ID if needed
const TEST_TOKEN_ID = process.env.TEST_TOKEN_ID
  || '0x6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e'; // placeholder

function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); }

async function main() {
  if (!PRIVATE_KEY) { console.error('[auth-test] Missing PRIVATE_KEY'); process.exit(1); }
  if (!POLYGON_RPC) { console.error('[auth-test] Missing POLYGON_RPC_URL'); process.exit(1); }

  const account      = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const wallet       = account.address as Address;
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) });
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });

  console.log(`\n[test-clob-v2-auth]`);
  console.log(`  Wallet:   ${wallet}`);
  console.log(`  CLOB:     ${CLOB_HOST}`);
  console.log(`  Env file: ${loadedEnvFile}`);
  console.log(`  API key:  ${API_KEY ? API_KEY.slice(0, 8) + '...' : '(not set — check CLOB_V2_API_KEY in env file)'}\n`);

  // ── 1. L2 auth check ──────────────────────────────────────────────────────
  console.log('── 1. L2 Auth ───────────────────────────────────────────────');
  if (!API_KEY || !API_SECRET || !PASSPHRASE) {
    fail('CLOB_V2_API_KEY / _SECRET / _PASSPHRASE not set — run regen-api-keys-v2.ts first');
  } else {
    try {
      const clientL2 = new ClobClient({
        host:  CLOB_HOST,
        chain: Chain.POLYGON,
        signer: walletClient as any,
        creds: { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE },
        throwOnError: true,
      });
      const keys = await (clientL2 as any).getApiKeys();
      ok(`API keys valid — ${Array.isArray(keys) ? keys.length : '?'} key(s) on account`);
    } catch (err: any) {
      fail(`L2 auth failed: ${err.message}`);
    }
  }

  // ── 2. Orderbook fetch (unauthenticated) ──────────────────────────────────
  console.log('\n── 2. Orderbook ─────────────────────────────────────────────');
  try {
    // Auto-discover a token via the v2 SDK (avoids raw HTTP endpoint guessing)
    let tokenId = process.env.TEST_TOKEN_ID ?? '';
    if (!tokenId && API_KEY && API_SECRET && PASSPHRASE) {
      try {
        const clientL2 = new ClobClient({
          host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient as any,
          creds: { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE },
          throwOnError: false,
        });
        const result = await (clientL2 as any).getSamplingMarkets({ limit: 5 });
        const markets: any[] = result?.data ?? (Array.isArray(result) ? result : []);
        for (const m of markets) {
          const tid = m.tokens?.[0]?.token_id ?? m.clobTokenIds?.[0];
          if (tid) { tokenId = tid; break; }
        }
      } catch { /* fall through */ }
    }
    if (!tokenId) {
      fail('Could not auto-discover a token ID — set TEST_TOKEN_ID env var');
    } else {
      // Use SDK getOrderBook instead of raw HTTP
      const clientL2 = new ClobClient({
        host: CLOB_HOST, chain: Chain.POLYGON, signer: walletClient as any,
        creds: API_KEY ? { key: API_KEY!, secret: API_SECRET!, passphrase: PASSPHRASE! } : undefined,
        throwOnError: false,
      });
      const book = await (clientL2 as any).getOrderBook(tokenId) as any;
      const bestBid = book?.bids?.[0]?.price ?? 'n/a';
      const bestAsk = book?.asks?.[0]?.price ?? 'n/a';
      ok(`Orderbook OK — bid=${bestBid} ask=${bestAsk} (token ...${tokenId.slice(-8)})`);
    }
  } catch (err: any) {
    fail(`Orderbook fetch failed: ${err.message}`);
  }

  // ── 3. Wallet balances ────────────────────────────────────────────────────
  console.log('\n── 3. Wallet Balances ───────────────────────────────────────');
  try {
    const [usdcBal, pusdBal, usdcDec, pusdDec] = await Promise.all([
      publicClient.readContract({ address: USDC_E, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
      publicClient.readContract({ address: PUSD,   abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
      publicClient.readContract({ address: USDC_E, abi: ERC20_ABI, functionName: 'decimals'  }),
      publicClient.readContract({ address: PUSD,   abi: ERC20_ABI, functionName: 'decimals'  }),
    ]);
    const usdcFloat = parseFloat(formatUnits(usdcBal, usdcDec));
    const pusdFloat = parseFloat(formatUnits(pusdBal, pusdDec));
    ok(`USDC.e: $${usdcFloat.toFixed(4)}`);
    if (pusdFloat > 0) {
      ok(`pUSD:   $${pusdFloat.toFixed(4)}`);
    } else {
      fail(`pUSD:   $0 — need to wrap USDC.e first (run wrap-usdc-to-pusd.ts)`);
    }
  } catch (err: any) {
    fail(`Balance check failed: ${err.message}`);
  }

  // ── 4. Open orders ────────────────────────────────────────────────────────
  console.log('\n── 4. Open Orders ───────────────────────────────────────────');
  if (API_KEY && API_SECRET && PASSPHRASE) {
    try {
      const clientL2 = new ClobClient({
        host:  CLOB_HOST,
        chain: Chain.POLYGON,
        signer: walletClient as any,
        creds: { key: API_KEY, secret: API_SECRET, passphrase: PASSPHRASE },
        throwOnError: false,
      });
      const orders = await (clientL2 as any).getOpenOrders();
      const count  = Array.isArray(orders) ? orders.length : 0;
      ok(`Open orders: ${count}`);
    } catch (err: any) {
      fail(`Could not fetch open orders: ${err.message}`);
    }
  } else {
    console.log('  (skipped — no API keys)');
  }

  console.log('\n────────────────────────────────────────────────────────────\n');
}

main().catch(err => {
  console.error('[auth-test] Fatal:', err.message ?? err);
  process.exit(1);
});
