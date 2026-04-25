/**
 * wrap-usdc-to-pusd.ts
 *
 * Converts USDC.e → pUSD via CollateralOnramp.wrap() at 1:1, zero fee.
 *
 * NOT a DEX swap. The CollateralOnramp is Polymarket's official wrapper:
 *   1. approve(CollateralOnramp, amount) on USDC.e
 *   2. wrap(USDC.e, bot_wallet, amount) on CollateralOnramp
 *
 * Usage:
 *   npx tsx scripts/wrap-usdc-to-pusd.ts             # dry-run (shows balances only)
 *   npx tsx scripts/wrap-usdc-to-pusd.ts --amount 5  # wrap $5
 *   npx tsx scripts/wrap-usdc-to-pusd.ts --amount 5 --execute
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import {
  createPublicClient, createWalletClient, http, formatUnits, parseUnits,
  type Address,
} from 'viem';
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

// ── Config ────────────────────────────────────────────────────────────────────
const PRIVATE_KEY  = process.env.PRIVATE_KEY || process.env.BOT_PRIVATE_KEY;
const POLYGON_RPC  = (process.env.POLYGON_WS_URL || process.env.POLYGON_RPC_URL || '')
  .replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');

if (!PRIVATE_KEY) {
  console.error('[wrap] Missing PRIVATE_KEY / BOT_PRIVATE_KEY in env');
  process.exit(1);
}
if (!POLYGON_RPC) {
  console.error('[wrap] Missing POLYGON_WS_URL / POLYGON_RPC_URL in env');
  process.exit(1);
}

// ── Addresses ─────────────────────────────────────────────────────────────────
const USDC_E_ADDRESS      = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as Address;
const PUSD_ADDRESS        = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as Address;
const COLLATERAL_ONRAMP   = '0x93070a847efEf7F70739046A929D47a521F5B8ee' as Address;

const ERC20_ABI = [
  { name: 'balanceOf',  type: 'function', stateMutability: 'view',     inputs: [{ name: 'account', type: 'address' }],                         outputs: [{ type: 'uint256' }] },
  { name: 'allowance',  type: 'function', stateMutability: 'view',     inputs: [{ name: 'owner',   type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve',    type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount',  type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'decimals',   type: 'function', stateMutability: 'view',     inputs: [],                                                              outputs: [{ type: 'uint8'  }] },
] as const;

const ONRAMP_ABI = [
  {
    name: 'wrap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'to',    type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const amountIdx = args.indexOf('--amount');
const amountStr = amountIdx !== -1 ? args[amountIdx + 1] : undefined;
const execute   = args.includes('--execute');

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const wallet  = account.address as Address;

  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) });

  // ── Read balances ────────────────────────────────────────────────────────
  const [usdcBal, pusdBal, usdcDec, pusdDec] = await Promise.all([
    publicClient.readContract({ address: USDC_E_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({ address: PUSD_ADDRESS,   abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({ address: USDC_E_ADDRESS, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: PUSD_ADDRESS,   abi: ERC20_ABI, functionName: 'decimals' }),
  ]);

  const usdcFloat = parseFloat(formatUnits(usdcBal, usdcDec));
  const pusdFloat = parseFloat(formatUnits(pusdBal, pusdDec));

  console.log('\n[wrap-usdc-to-pusd]');
  console.log(`  Wallet:        ${wallet}`);
  console.log(`  USDC.e balance: $${usdcFloat.toFixed(6)}`);
  console.log(`  pUSD balance:   $${pusdFloat.toFixed(6)}`);

  if (!amountStr) {
    console.log('\n  Dry-run mode — pass --amount <N> --execute to wrap.\n');
    return;
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error(`\n  Invalid amount: ${amountStr}`);
    process.exit(1);
  }
  if (amount < 1) {
    console.warn(`  Warning: Polymarket minimum deposit via bridge is $2. Amounts < $1 may revert.`);
  }
  if (amount > usdcFloat) {
    console.error(`\n  Insufficient USDC.e: have $${usdcFloat.toFixed(2)}, need $${amount.toFixed(2)}`);
    process.exit(1);
  }

  const amountRaw = parseUnits(amount.toFixed(6), usdcDec);
  console.log(`\n  Wrap amount:    $${amount} (${amountRaw} raw)`);

  if (!execute) {
    console.log('\n  Simulation mode — add --execute flag to submit transactions.\n');
    return;
  }

  // ── Step 1: Approve CollateralOnramp to spend USDC.e ────────────────────
  const allowance = await publicClient.readContract({
    address: USDC_E_ADDRESS, abi: ERC20_ABI,
    functionName: 'allowance', args: [wallet, COLLATERAL_ONRAMP],
  });

  if (allowance < amountRaw) {
    console.log(`\n  Approving CollateralOnramp for ${formatUnits(amountRaw, usdcDec)} USDC.e...`);
    const approveHash = await walletClient.writeContract({
      address: USDC_E_ADDRESS, abi: ERC20_ABI,
      functionName: 'approve', args: [COLLATERAL_ONRAMP, amountRaw],
    });
    console.log(`  approve tx: ${approveHash}`);
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approveReceipt.status !== 'success') {
      console.error('  approve tx FAILED — aborting');
      process.exit(1);
    }
    console.log('  approve confirmed');
  } else {
    console.log(`\n  Allowance already sufficient (${formatUnits(allowance, usdcDec)} USDC.e) — skipping approve`);
  }

  // ── Step 2: wrap(USDC.e, wallet, amount) ────────────────────────────────
  console.log(`\n  Calling CollateralOnramp.wrap(USDC.e, ${wallet}, ${formatUnits(amountRaw, usdcDec)})...`);
  const wrapHash = await walletClient.writeContract({
    address: COLLATERAL_ONRAMP, abi: ONRAMP_ABI,
    functionName: 'wrap', args: [USDC_E_ADDRESS, wallet, amountRaw],
  });
  console.log(`  wrap tx: ${wrapHash}`);
  const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapHash });
  if (wrapReceipt.status !== 'success') {
    console.error('  wrap tx FAILED');
    process.exit(1);
  }
  console.log('  wrap confirmed ✓');

  // ── Step 3: Verify new balances ──────────────────────────────────────────
  const [usdcAfter, pusdAfter] = await Promise.all([
    publicClient.readContract({ address: USDC_E_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
    publicClient.readContract({ address: PUSD_ADDRESS,   abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
  ]);

  const usdcAfterFloat = parseFloat(formatUnits(usdcAfter, usdcDec));
  const pusdAfterFloat = parseFloat(formatUnits(pusdAfter, pusdDec));
  const pusdGained     = pusdAfterFloat - pusdFloat;

  console.log('\n  ── After wrap ─────────────────────────────────────────────');
  console.log(`  USDC.e: $${usdcFloat.toFixed(6)} → $${usdcAfterFloat.toFixed(6)} (−$${(usdcFloat - usdcAfterFloat).toFixed(6)})`);
  console.log(`  pUSD:   $${pusdFloat.toFixed(6)} → $${pusdAfterFloat.toFixed(6)} (+$${pusdGained.toFixed(6)})`);

  if (Math.abs(pusdGained - amount) < 0.01) {
    console.log('\n  1:1 conversion confirmed ✓\n');
  } else {
    console.warn(`\n  Warning: expected +$${amount}, got +$${pusdGained.toFixed(6)}\n`);
  }
}

main().catch(err => {
  console.error('[wrap] Fatal:', err.message);
  process.exit(1);
});
