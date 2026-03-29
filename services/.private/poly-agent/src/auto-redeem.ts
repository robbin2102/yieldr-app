/**
 * Auto-Redeemer — runs continuously, checks for winning positions every 60s
 * and redeems them using CTF.redeemPositions with legacy gas.
 *
 * Run in a separate terminal alongside the trading bot.
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/auto-redeem.ts
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';

const envPaths = [
  path.resolve(process.cwd(), 'services/.private/poly-agent/.env.polyagent'),
  path.resolve(process.cwd(), '.env.local'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envPaths) {
  const r = dotenv.config({ path: p });
  if (r.parsed?.BOT_PRIVATE_KEY) break;
}

const provider = new ethers.providers.StaticJsonRpcProvider(
  process.env.POLYGON_RPC_URL!,
  { name: 'polygon', chainId: parseInt(process.env.CHAIN_ID || '137') }
);
const wallet = new ethers.Wallet(process.env.BOT_PRIVATE_KEY!, provider);

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const DATA_API = process.env.DATA_API_BASE || 'https://data-api.polymarket.com';
const CHECK_INTERVAL_MS = 60000; // Check every 60s

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ctf = new ethers.Contract(CTF, [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
], wallet);
const usdc = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);

// Track already-redeemed conditionIds to avoid retrying
const redeemedSet = new Set<string>();
let totalRedeemed = 0;
let totalGasUsed = 0;

async function checkAndRedeem(): Promise<void> {
  try {
    const posRes = await fetch(`${DATA_API}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
    if (!posRes.ok) { console.log(`[Redeem] API error: ${posRes.status}`); return; }
    const positions = await posRes.json() as any[];

    const winners = positions.filter((p: any) =>
      p.curPrice >= 0.99 && !redeemedSet.has(p.conditionId)
    );

    if (winners.length === 0) return;

    const usdcBefore = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;

    for (const p of winners) {
      // Verify on-chain balance
      const tokenId = ethers.BigNumber.from(p.asset);
      const balance = await ctf.balanceOf(wallet.address, tokenId);

      if (balance.isZero()) {
        redeemedSet.add(p.conditionId); // Already redeemed
        continue;
      }

      console.log(`[Redeem] 💰 ${p.outcome} ${(parseInt(balance.toString()) / 1e6).toFixed(2)} shares | ${p.title?.slice(0, 50)}`);

      try {
        const gasPrice = await provider.getGasPrice();
        const tx = await ctf.redeemPositions(
          USDC_E,
          ethers.constants.HashZero,
          p.conditionId,
          [1, 2],
          { gasLimit: 200000, gasPrice: gasPrice.mul(3) }
        );
        const receipt = await tx.wait();
        const gasUsed = parseInt(receipt.gasUsed.toString());
        totalGasUsed += gasUsed;
        totalRedeemed++;
        redeemedSet.add(p.conditionId);

        console.log(`[Redeem] ✅ TX: ${tx.hash.slice(0, 20)}... Gas: ${gasUsed}`);
      } catch (err: any) {
        console.log(`[Redeem] ❌ ${err.reason || err.message?.slice(0, 100)}`);
        // Don't add to redeemedSet — will retry next check
      }

      await sleep(2000); // Brief pause between redeems
    }

    const usdcAfter = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
    if (usdcAfter > usdcBefore) {
      console.log(`[Redeem] 💵 Balance: $${usdcBefore.toFixed(2)} → $${usdcAfter.toFixed(2)} (+$${(usdcAfter - usdcBefore).toFixed(2)}) | Total redeemed: ${totalRedeemed}`);
    }
  } catch (err: any) {
    console.log(`[Redeem] Error: ${err.message?.slice(0, 100)}`);
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Auto-Redeemer — checks every 60s for winners        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Wallet: ${wallet.address}`);
  console.log(`  Check interval: ${CHECK_INTERVAL_MS / 1000}s\n`);

  const bal = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`  Starting USDC.e: $${bal.toFixed(2)}\n`);

  // Initial check
  await checkAndRedeem();

  // Loop
  while (true) {
    await sleep(CHECK_INTERVAL_MS);
    await checkAndRedeem();
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
