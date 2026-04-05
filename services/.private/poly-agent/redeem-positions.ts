/**
 * redeem-positions.ts
 *
 * Checks all bot wallet positions and redeems any that are resolved (curPrice >= 0.99).
 * Uses the same CTF contract + ethers pattern as allowances.ts.
 *
 * Run:
 *   npx tsx redeem-positions.ts            — dry run (shows what would be redeemed)
 *   npx tsx redeem-positions.ts --execute  — actually sends redemption transactions
 */

import { ethers } from 'ethers';
import { config } from './src/config';

const DRY_RUN = !process.argv.includes('--execute');

const DATA_API = config.dataApiBase || 'https://data-api.polymarket.com';

// Polygon mainnet contract addresses (same as allowances.ts)
const CONTRACTS = {
  USDC:               '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  CTF:                '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
  NEG_RISK_ADAPTER:   '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};

// CTF redeemPositions ABI
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
];

// NegRisk adapter redeemPositions ABI (for negRisk markets)
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256 amounts) external',
];

async function main() {
  console.log(`\nBot wallet : ${config.botWalletAddress}`);
  console.log(`Mode       : ${DRY_RUN ? 'DRY RUN (add --execute to send txs)' : '⚡ EXECUTE MODE'}\n`);

  // ── 1. Fetch all positions ─────────────────────────────────────────────────
  console.log('Fetching positions...');
  const res  = await fetch(`${DATA_API}/positions?user=${config.botWalletAddress}&sizeThreshold=0.01&limit=500`);
  const raw  = await res.json() as any;
  const all: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);

  console.log(`Found ${all.length} position(s) total.\n`);

  // ── 2. Show all positions ─────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════════════');
  console.log('  ALL POSITIONS');
  console.log('══════════════════════════════════════════════════════════');

  let totalValue = 0;
  let totalCost  = 0;

  all.forEach((p: any, i: number) => {
    const size         = parseFloat(p.size         ?? '0');
    const curPrice     = parseFloat(p.curPrice     ?? '0');
    const avgPrice     = parseFloat(p.avgPrice     ?? '0');
    const currentValue = parseFloat(p.currentValue ?? String(size * curPrice));
    const initialValue = parseFloat(p.initialValue ?? String(size * avgPrice));
    const cashPnl      = currentValue - initialValue;
    const redeemable   = p.redeemable === true || curPrice >= 0.99;
    const sign         = cashPnl >= 0 ? '+' : '';

    totalValue += currentValue;
    totalCost  += initialValue;

    console.log(
      `\n  [${i + 1}] ${(p.title ?? 'Unknown').slice(0, 60)}\n` +
      `      Outcome     : ${p.outcome ?? '—'}  |  negRisk: ${p.negRisk ? 'yes' : 'no'}\n` +
      `      Shares      : ${size.toFixed(4)}\n` +
      `      Avg price   : $${avgPrice.toFixed(4)}  →  Cur price: $${curPrice.toFixed(4)}\n` +
      `      Cost        : $${initialValue.toFixed(2)}  →  Value: $${currentValue.toFixed(2)}\n` +
      `      PnL         : ${sign}$${cashPnl.toFixed(2)}\n` +
      `      conditionId : ${p.conditionId ?? '—'}\n` +
      `      Redeemable  : ${redeemable ? '✅ YES' : '❌ no'}`
    );
  });

  const totalPnl = totalValue - totalCost;
  const totalSign = totalPnl >= 0 ? '+' : '';
  console.log('\n──────────────────────────────────────────────────────────');
  console.log(`  Total cost    : $${totalCost.toFixed(2)}`);
  console.log(`  Total value   : $${totalValue.toFixed(2)}`);
  console.log(`  Total PnL     : ${totalSign}$${totalPnl.toFixed(2)}`);
  console.log('══════════════════════════════════════════════════════════\n');

  // ── 3. Filter redeemable positions (skip $0 value — nothing to collect) ──
  const redeemable = all.filter((p: any) => {
    const isResolved = p.redeemable === true || parseFloat(p.curPrice ?? '0') >= 0.99;
    if (!isResolved) return false;
    const size  = parseFloat(p.size ?? '0');
    const value = parseFloat(p.currentValue ?? String(size * parseFloat(p.curPrice ?? '0')));
    return value > 0.005;  // skip dust / losing positions
  });

  if (redeemable.length === 0) {
    console.log('No redeemable positions found. Nothing to do.\n');
    return;
  }

  console.log(`Found ${redeemable.length} redeemable position(s):\n`);
  redeemable.forEach((p: any) => {
    const size  = parseFloat(p.size ?? '0');
    const value = parseFloat(p.currentValue ?? String(size * parseFloat(p.curPrice ?? '0')));
    console.log(`  ✅ ${(p.title ?? '').slice(0, 55)} [${p.outcome}]  ${size.toFixed(4)} shares  ~$${value.toFixed(2)}`);
  });

  if (DRY_RUN) {
    console.log('\nDry run complete. Add --execute to actually redeem.\n');
    return;
  }

  // ── 4. Setup wallet + contracts ───────────────────────────────────────────
  console.log('\nConnecting to Polygon...');
  const provider = new ethers.providers.StaticJsonRpcProvider(config.polygonRpcUrl, {
    name: 'polygon', chainId: config.chainId,
  });
  const wallet      = new ethers.Wallet(config.botPrivateKey, provider);
  const ctf         = new ethers.Contract(CONTRACTS.CTF,             CTF_ABI,         wallet);
  const negRiskAdap = new ethers.Contract(CONTRACTS.NEG_RISK_ADAPTER, NEG_RISK_ABI,   wallet);

  const PARENT_COLLECTION_ID = ethers.constants.HashZero;  // 0x000...0 for root positions
  // Fetch live gas prices and add 30% headroom so TX confirms promptly
  const feeData = await provider.getFeeData();
  const basePriorityFee = feeData.maxPriorityFeePerGas ?? ethers.utils.parseUnits('30', 'gwei');
  const baseMaxFee      = feeData.maxFeePerGas         ?? ethers.utils.parseUnits('300', 'gwei');
  const gasBump = {
    gasLimit:             300_000,
    maxPriorityFeePerGas: basePriorityFee.mul(130).div(100),  // +30% over live estimate
    maxFeePerGas:         baseMaxFee.mul(130).div(100),        // +30% ceiling
  };
  console.log(`  Gas: priority=${ethers.utils.formatUnits(gasBump.maxPriorityFeePerGas, 'gwei')} Gwei  max=${ethers.utils.formatUnits(gasBump.maxFeePerGas, 'gwei')} Gwei`);

  // ── 5. Redeem each position ───────────────────────────────────────────────
  console.log('\nExecuting redemptions...\n');

  for (const p of redeemable) {
    const conditionId = p.conditionId;
    const size        = parseFloat(p.size ?? '0');
    const outcome     = (p.outcome ?? '').toUpperCase();
    const isNegRisk   = p.negRisk === true;

    if (!conditionId) {
      console.log(`  ⚠️  Skipping "${(p.title ?? '').slice(0, 40)}" — no conditionId`);
      continue;
    }

    // indexSets: YES outcome = index 0 → indexSet 1 (binary: 2^0)
    //            NO  outcome = index 1 → indexSet 2 (binary: 2^1)
    const indexSet = outcome === 'YES' || outcome === 'NO' ? (outcome === 'YES' ? 1 : 2) : 1;

    try {
      console.log(`  Redeeming: ${(p.title ?? '').slice(0, 50)} [${outcome}]`);
      console.log(`    conditionId: ${conditionId}`);
      console.log(`    indexSet: ${indexSet}  |  negRisk: ${isNegRisk}`);

      let tx: ethers.ContractTransaction;

      if (isNegRisk) {
        // NegRisk markets use the adapter contract
        const sharesToRedeem = ethers.utils.parseUnits(size.toFixed(6), 6);  // USDC 6 decimals
        tx = await negRiskAdap.redeemPositions(conditionId, sharesToRedeem, gasBump);
      } else {
        // Standard CTF markets
        tx = await ctf.redeemPositions(
          CONTRACTS.USDC,
          PARENT_COLLECTION_ID,
          conditionId,
          [indexSet],
          gasBump
        );
      }

      console.log(`    TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    ✅ Confirmed in block ${receipt.blockNumber}  (gas: ${receipt.gasUsed.toString()})\n`);

    } catch (err: any) {
      console.error(`    ❌ Failed: ${err.message}\n`);
    }
  }

  console.log('Redemption complete.\n');
}

main().catch(console.error);
