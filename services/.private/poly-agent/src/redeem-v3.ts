/**
 * Redeem v3 — Approve NegRisk Adapter + Redeem
 *
 * BTC 5m markets are NegRisk markets.
 * CTF.redeemPositions doesn't work for them.
 * Must use NegRiskAdapter.redeemPositions instead.
 * But first need CTF.setApprovalForAll(NegRiskAdapter, true).
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/redeem-v3.ts
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
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const DATA_API = process.env.DATA_API_BASE || 'https://data-api.polymarket.com';

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Redeem v3 — Approve + NegRisk Redeem                ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`Wallet: ${wallet.address}\n`);

  const ctf = new ethers.Contract(CTF, [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved) external',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
  ], wallet);

  const usdc = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const feeData = await provider.getFeeData();

  const gasOptions = {
    gasLimit: 200000,
    maxFeePerGas: feeData.maxFeePerGas?.mul(2) || ethers.utils.parseUnits('100', 'gwei'),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(2) || ethers.utils.parseUnits('30', 'gwei'),
  };

  // Step 1: Check + Set approval for NegRisk Adapter
  console.log('[1] Checking NegRisk Adapter approval...');
  const isApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
  console.log(`  Current approval: ${isApproved}`);

  if (!isApproved) {
    console.log('  Setting approval...');
    try {
      const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, gasOptions);
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  ✅ Approved! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
    } catch (err: any) {
      console.error(`  ❌ Approval failed: ${err.reason || err.message?.slice(0, 200)}`);
      console.log('  Cannot proceed without approval. Exiting.');
      return;
    }

    // Verify
    const nowApproved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
    console.log(`  Verified: ${nowApproved}\n`);
  } else {
    console.log('  Already approved ✅\n');
  }

  // Step 2: Fetch winning positions
  console.log('[2] Fetching winning positions...');
  const posRes = await fetch(`${DATA_API}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
  const positions = posRes.ok ? await posRes.json() as any[] : [];
  const winners = positions.filter((p: any) => p.curPrice >= 0.99);
  console.log(`  ${winners.length} winners found\n`);

  const usdcBefore = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`  USDC.e before: $${usdcBefore.toFixed(6)}\n`);

  // Step 3: Redeem each winner via NegRisk Adapter
  const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
    'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
  ], wallet);

  for (const p of winners) {
    console.log(`[3] Redeeming: ${p.outcome} ${p.size?.toFixed(2)} shares | ${p.title?.slice(0, 50)}`);
    console.log(`    conditionId: ${p.conditionId}`);

    // Get actual on-chain balance
    const tokenId = ethers.BigNumber.from(p.asset);
    const balance = await ctf.balanceOf(wallet.address, tokenId);
    console.log(`    On-chain balance: ${balance.toString()} (${(parseInt(balance.toString()) / 1e6).toFixed(6)} tokens)`);

    if (balance.isZero()) {
      console.log(`    ⚠️ No balance — skipping\n`);
      continue;
    }

    // NegRisk adapter: amounts = [upAmount, downAmount]
    // Pass the full balance for the winning side, 0 for the losing side
    const amounts = p.outcomeIndex === 0
      ? [balance, ethers.BigNumber.from(0)]
      : [ethers.BigNumber.from(0), balance];

    console.log(`    outcomeIndex: ${p.outcomeIndex}`);
    console.log(`    amounts: [${amounts[0].toString()}, ${amounts[1].toString()}]`);

    try {
      const tx = await adapter.redeemPositions(p.conditionId, amounts, {
        ...gasOptions,
        gasLimit: 500000, // Higher for redeem
      });
      console.log(`    TX: ${tx.hash}`);
      console.log(`    Waiting for confirmation...`);
      const receipt = await tx.wait();
      console.log(`    ✅ REDEEMED! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);

      // Check new balance
      const newBalance = await ctf.balanceOf(wallet.address, tokenId);
      console.log(`    Token balance after: ${newBalance.toString()} (should be 0)`);
    } catch (err: any) {
      console.log(`    ❌ Failed: ${err.reason || err.message?.slice(0, 200)}`);
    }
    console.log('');
  }

  // Final balance
  const usdcAfter = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  USDC.e before: $${usdcBefore.toFixed(6)}`);
  console.log(`  USDC.e after:  $${usdcAfter.toFixed(6)}`);
  console.log(`  Gained:        $${(usdcAfter - usdcBefore).toFixed(6)}`);
  console.log(`═══════════════════════════════════════════════════════\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
