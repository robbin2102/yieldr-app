/**
 * Withdraw USDC from Polymarket Exchange to Wallet
 *
 * Polymarket holds USDC in the CTF Exchange contract.
 * This script withdraws it back to the EOA wallet.
 *
 * Also attempts to redeem winning positions using the CLOB client's
 * built-in merge/redeem functionality.
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/withdraw.ts           ← show balances
 *   npx tsx services/.private/poly-agent/src/withdraw.ts redeem    ← redeem winning positions
 *   npx tsx services/.private/poly-agent/src/withdraw.ts withdraw  ← withdraw from exchange
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

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

async function main() {
  const action = process.argv[2] || 'show';

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Polymarket Withdraw & Redeem                        ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, { name: 'polygon', chainId: CONFIG.chainId });
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);
  console.log(`Wallet: ${wallet.address}\n`);

  // Balances
  const usdcContract = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const walletUsdc = parseInt((await usdcContract.balanceOf(wallet.address)).toString()) / 1e6;
  const exchangeUsdc = parseInt((await usdcContract.balanceOf(CTF_EXCHANGE)).toString()) / 1e6;
  const negRiskUsdc = parseInt((await usdcContract.balanceOf(NEG_RISK_EXCHANGE)).toString()) / 1e6;

  console.log(`  Wallet USDC.e:      $${walletUsdc.toFixed(2)}`);
  console.log(`  CTF Exchange total: $${exchangeUsdc.toFixed(0)} (all users)`);
  console.log(`  NegRisk Exchange:   $${negRiskUsdc.toFixed(0)} (all users)`);

  // Positions
  console.log('\n═══ YOUR POSITIONS ═══\n');
  const posRes = await fetch(`${CONFIG.dataApiBase}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
  const positions = posRes.ok ? await posRes.json() as any[] : [];

  const winners: any[] = [];
  for (const p of positions) {
    const status = p.curPrice >= 0.99 ? '✅ WIN' : p.curPrice <= 0.01 ? '❌ LOSS' : '⏳ OPEN';
    if (p.curPrice >= 0.99) winners.push(p);
    console.log(`  ${status} | ${p.outcome} ${p.size?.toFixed(2)} shares | val=$${((p.size || 0) * (p.curPrice || 0)).toFixed(2)} | ${p.title?.slice(0, 45)}`);
    console.log(`         asset: ${p.asset}`);
    console.log(`         conditionId: ${p.conditionId}`);
  }

  console.log(`\n  Redeemable: ${winners.length} positions, $${winners.reduce((s: number, p: any) => s + (p.size || 0), 0).toFixed(2)}`);

  if (action === 'show') {
    console.log('\n  Commands:');
    console.log('    npx tsx services/.private/poly-agent/src/withdraw.ts redeem');
    console.log('    npx tsx services/.private/poly-agent/src/withdraw.ts withdraw\n');
    return;
  }

  if (action === 'redeem' && winners.length > 0) {
    console.log('\n═══ REDEEMING ═══\n');

    // BTC 5m markets are NegRisk markets
    // The CTF token IDs (asset field) are ERC1155 token IDs
    // We need to call the NegRiskAdapter to redeem

    // For NegRisk redemption, we need BOTH outcome tokens for the same condition
    // But for resolved markets, only the winning side has value
    // The adapter's redeemPositions should handle this

    for (const p of winners) {
      console.log(`  Redeeming: ${p.outcome} ${p.size?.toFixed(2)} shares`);
      console.log(`    asset (tokenId): ${p.asset}`);

      try {
        // Convert size to raw token amount (ERC1155 tokens use 6 decimals for Polymarket)
        const rawAmount = ethers.BigNumber.from(Math.floor(p.size * 1e6).toString());

        // Try redeeming via NegRiskAdapter
        const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
          'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
        ], wallet);

        // For a winning position, we pass the winning amount and 0 for the losing side
        const amounts = p.outcomeIndex === 0
          ? [rawAmount, ethers.BigNumber.from(0)]
          : [ethers.BigNumber.from(0), rawAmount];

        console.log(`    Attempting NegRisk redeem...`);
        console.log(`    conditionId: ${p.conditionId}`);
        console.log(`    amounts: [${amounts[0].toString()}, ${amounts[1].toString()}]`);

        const gasPrice = await provider.getGasPrice();
        const tx = await adapter.redeemPositions(p.conditionId, amounts, {
          gasLimit: 300000,
          gasPrice: gasPrice.mul(120).div(100), // 20% above current
        });
        console.log(`    TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`    ✅ Confirmed! Block: ${receipt.blockNumber}, Gas: ${receipt.gasUsed.toString()}`);
      } catch (err: any) {
        const msg = err.message || '';
        console.log(`    ❌ NegRisk failed: ${msg.slice(0, 150)}`);

        // Try direct CTF redeem as fallback
        try {
          console.log(`    Trying direct CTF redeem...`);
          const ctf = new ethers.Contract(CTF, [
            'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
          ], wallet);

          const indexSets = [1, 2]; // Both outcomes
          const tx = await ctf.redeemPositions(
            USDC_E,
            ethers.constants.HashZero,
            p.conditionId,
            indexSets,
            { gasLimit: 300000 }
          );
          console.log(`    TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`    ✅ Confirmed! Block: ${receipt.blockNumber}`);
        } catch (err2: any) {
          console.log(`    ❌ CTF also failed: ${err2.message?.slice(0, 150)}`);

          // Try the CLOB merge endpoint
          try {
            console.log(`    Trying CLOB merge/redeem API...`);
            const mergeRes = await fetch(`${CONFIG.clobApiBase}/redeem`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'POLY_API_KEY': CONFIG.apiKey,
                'POLY_SIGNATURE': CONFIG.apiSecret,
                'POLY_TIMESTAMP': Date.now().toString(),
                'POLY_PASSPHRASE': CONFIG.passphrase,
              },
              body: JSON.stringify({
                conditionId: p.conditionId,
              }),
            });
            if (mergeRes.ok) {
              const result = await mergeRes.json();
              console.log(`    ✅ CLOB redeem response:`, JSON.stringify(result));
            } else {
              const errBody = await mergeRes.text();
              console.log(`    ❌ CLOB redeem ${mergeRes.status}: ${errBody.slice(0, 150)}`);
            }
          } catch (err3: any) {
            console.log(`    ❌ All redeem methods failed.`);
            console.log(`    → Manual: use Polymarket Relayer or import wallet into UI`);
          }
        }
      }
      console.log('');
    }

    const walletUsdcAfter = parseInt((await usdcContract.balanceOf(wallet.address)).toString()) / 1e6;
    console.log(`  USDC.e after redeem: $${walletUsdcAfter.toFixed(6)}`);
    console.log(`  Gained: $${(walletUsdcAfter - walletUsdc).toFixed(6)}\n`);
  }

  if (action === 'withdraw') {
    console.log('\n═══ WITHDRAW INFO ═══\n');
    console.log('  For Polymarket, funds flow:');
    console.log('  1. You deposit USDC.e → CTF Exchange contract');
    console.log('  2. Orders lock USDC.e on the exchange');
    console.log('  3. Cancelled orders: USDC stays on exchange (available for new orders)');
    console.log('  4. Winning positions: redeem → USDC.e returned to wallet');
    console.log('');
    console.log('  The USDC.e from cancelled orders is NOT automatically returned.');
    console.log('  It stays as exchange balance for future trades.');
    console.log('');
    console.log('  To get it back, you need to withdraw via:');
    console.log('  - Polymarket UI (if proxy wallet is linked)');
    console.log('  - Or redeem any remaining positions first\n');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
