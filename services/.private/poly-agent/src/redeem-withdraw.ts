/**
 * Redeem Winning Positions + Withdraw USDC to Wallet
 *
 * 1. Finds all positions where curPrice >= 0.99 (winners)
 * 2. Redeems them via Polymarket Relayer API (gasless)
 * 3. Shows updated balance
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/redeem-withdraw.ts           ← show redeemable positions
 *   npx tsx services/.private/poly-agent/src/redeem-withdraw.ts redeem    ← redeem all winners
 *   npx tsx services/.private/poly-agent/src/redeem-withdraw.ts withdraw  ← withdraw USDC to wallet
 */

import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
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

const CONFIG = {
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,
  apiKey: process.env.POLYMARKET_API_KEY!,
  apiSecret: process.env.POLYMARKET_API_SECRET!,
  passphrase: process.env.POLYMARKET_PASSPHRASE!,
  clobApiBase: process.env.CLOB_API_BASE || 'https://clob.polymarket.com',
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
};

// Polymarket contract addresses
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Minimal ABIs
const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
];

async function main() {
  const action = process.argv[2] || 'show';

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Redeem & Withdraw Tool                              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, { name: 'polygon', chainId: CONFIG.chainId });
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);
  console.log(`Wallet: ${wallet.address}\n`);

  // Check USDC.e balance
  const usdcContract = new ethers.Contract(USDC_E_ADDRESS, USDC_ABI, provider);
  const usdcBefore = await usdcContract.balanceOf(wallet.address);
  console.log(`USDC.e balance (wallet): $${(parseInt(usdcBefore.toString()) / 1e6).toFixed(6)}\n`);

  // Fetch positions
  console.log('═══ POSITIONS ═══\n');
  const posRes = await fetch(`${CONFIG.dataApiBase}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
  if (!posRes.ok) { console.error('Failed to fetch positions'); return; }
  const positions = await posRes.json() as any[];

  const winners: any[] = [];
  const losers: any[] = [];

  for (const p of positions) {
    const value = (p.size || 0) * (p.curPrice || 0);
    const status = p.curPrice >= 0.99 ? '✅ WIN' : p.curPrice <= 0.01 ? '❌ LOSS' : '⏳ OPEN';

    if (p.curPrice >= 0.99) winners.push(p);
    else if (p.curPrice <= 0.01) losers.push(p);

    console.log(`  ${status} | ${p.outcome} ${p.size?.toFixed(2)} shares @ ${(p.avgPrice * 100).toFixed(0)}c | val=$${value.toFixed(2)} | ${p.title?.slice(0, 45)}`);
    console.log(`         conditionId: ${p.conditionId?.slice(0, 20)}... | asset: ${p.asset?.slice(0, 20)}...`);
  }

  const totalWinValue = winners.reduce((s: number, p: any) => s + (p.size || 0), 0);
  const totalLostCost = losers.reduce((s: number, p: any) => s + (p.totalBought || 0), 0);

  console.log(`\n  Winners: ${winners.length} positions, $${totalWinValue.toFixed(2)} to redeem`);
  console.log(`  Losers:  ${losers.length} positions, $${totalLostCost.toFixed(2)} lost`);

  if (action === 'show') {
    console.log('\n  To redeem: npx tsx services/.private/poly-agent/src/redeem-withdraw.ts redeem');
    console.log('  To withdraw: npx tsx services/.private/poly-agent/src/redeem-withdraw.ts withdraw\n');
    return;
  }

  // === REDEEM ===
  if (action === 'redeem') {
    if (winners.length === 0) {
      console.log('\n  No winning positions to redeem.\n');
      return;
    }

    console.log(`\n═══ REDEEMING ${winners.length} WINNING POSITIONS ═══\n`);

    for (const p of winners) {
      console.log(`  Redeeming: ${p.outcome} ${p.size?.toFixed(2)} shares | ${p.title?.slice(0, 50)}`);
      console.log(`    conditionId: ${p.conditionId}`);

      try {
        // Use the NegRiskAdapter for BTC Up/Down markets
        const negRisk = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);

        // For neg risk markets, we need to call redeemPositions with the conditionId
        // and amounts array matching the outcome indexes
        const conditionIdBytes = p.conditionId;

        // The amounts array: [upAmount, downAmount]
        // For winning Up: amounts = [shares, 0]
        // For winning Down: amounts = [0, shares]
        const sharesBN = ethers.utils.parseUnits(p.size.toFixed(6), 6);

        let amounts: ethers.BigNumber[];
        if (p.outcomeIndex === 0) {
          amounts = [sharesBN, ethers.BigNumber.from(0)];
        } else {
          amounts = [ethers.BigNumber.from(0), sharesBN];
        }

        console.log(`    Calling redeemPositions...`);
        const tx = await negRisk.redeemPositions(conditionIdBytes, amounts, {
          gasLimit: 500000,
        });
        console.log(`    TX submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`    ✅ Confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed.toString()}`);
      } catch (err: any) {
        console.log(`    ❌ Redeem failed: ${err.message?.slice(0, 100)}`);

        // Fallback: try using the CTF contract directly
        console.log(`    Trying CTF direct redeem...`);
        try {
          const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, wallet);
          const parentCollectionId = ethers.constants.HashZero;
          const indexSets = p.outcomeIndex === 0 ? [1] : [2];

          const tx = await ctf.redeemPositions(
            USDC_E_ADDRESS,
            parentCollectionId,
            p.conditionId,
            indexSets,
            { gasLimit: 500000 }
          );
          console.log(`    TX submitted: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`    ✅ Confirmed in block ${receipt.blockNumber}`);
        } catch (err2: any) {
          console.log(`    ❌ CTF redeem also failed: ${err2.message?.slice(0, 100)}`);
          console.log(`    → Try redeeming via Polymarket UI instead`);
        }
      }
    }

    // Check updated balance
    const usdcAfter = await usdcContract.balanceOf(wallet.address);
    console.log(`\n  USDC.e balance after: $${(parseInt(usdcAfter.toString()) / 1e6).toFixed(6)}`);
    console.log(`  Gained: $${((parseInt(usdcAfter.toString()) - parseInt(usdcBefore.toString())) / 1e6).toFixed(6)}\n`);
  }

  // === WITHDRAW ===
  if (action === 'withdraw') {
    console.log('\n═══ WITHDRAW ═══\n');
    console.log('  Polymarket exchange funds are already in USDC.e on Polygon.');
    console.log('  After redeeming positions, USDC.e goes directly to your wallet.');
    console.log(`\n  Current USDC.e in wallet: $${(parseInt(usdcBefore.toString()) / 1e6).toFixed(6)}`);
    console.log('  After redeeming, run check-balance.ts to see updated amount.\n');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
