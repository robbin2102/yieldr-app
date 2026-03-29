/**
 * Redeem Winning Tokens — following Polymarket docs exactly
 *
 * Step 1: Check if tokens are in wallet or exchange
 * Step 2: If in exchange, they should auto-settle. If in wallet, redeem.
 * Step 3: Call CTF.redeemPositions(USDC_E, 0x0, conditionId, [1,2])
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/redeem-v2.ts
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
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const DATA_API = process.env.DATA_API_BASE || 'https://data-api.polymarket.com';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
];

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Redeem Winning Tokens v2 (per Polymarket docs)      ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  console.log(`Wallet: ${wallet.address}\n`);

  const ctf = new ethers.Contract(CTF, CTF_ABI, wallet);
  const usdc = new ethers.Contract(USDC_E, USDC_ABI, provider);

  // Gas price
  const feeData = await provider.getFeeData();
  console.log(`Gas: maxFee=${ethers.utils.formatUnits(feeData.maxFeePerGas || 0, 'gwei')} gwei, priority=${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas || 0, 'gwei')} gwei\n`);

  // USDC balance before
  const usdcBefore = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`USDC.e before: $${usdcBefore.toFixed(6)}\n`);

  // Check approvals
  const approvedCTFExchange = await ctf.isApprovedForAll(wallet.address, CTF_EXCHANGE);
  const approvedNegRisk = await ctf.isApprovedForAll(wallet.address, NEG_RISK_CTF_EXCHANGE);
  const approvedAdapter = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
  console.log(`Approvals: CTF_Exchange=${approvedCTFExchange} NegRisk_Exchange=${approvedNegRisk} NegRisk_Adapter=${approvedAdapter}\n`);

  // Fetch winning positions
  const posRes = await fetch(`${DATA_API}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
  const positions = posRes.ok ? await posRes.json() as any[] : [];
  const winners = positions.filter((p: any) => p.curPrice >= 0.99);

  console.log(`Total positions: ${positions.length} | Winners: ${winners.length}\n`);

  for (const p of winners) {
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`  ${p.title?.slice(0, 55)}`);
    console.log(`  ${p.outcome} | ${p.size?.toFixed(2)} shares @ ${(p.avgPrice * 100).toFixed(0)}c`);
    console.log(`  conditionId: ${p.conditionId}`);
    console.log(`  asset (tokenId): ${p.asset}`);

    // Check on-chain balance
    const tokenId = ethers.BigNumber.from(p.asset);
    const balance = await ctf.balanceOf(wallet.address, tokenId);
    console.log(`  On-chain balance (wallet): ${balance.toString()} raw = ${(parseInt(balance.toString()) / 1e6).toFixed(6)} tokens`);

    // Also check exchange contract balance
    const exchangeBalance = await ctf.balanceOf(CTF_EXCHANGE, tokenId);
    const negRiskBalance = await ctf.balanceOf(NEG_RISK_CTF_EXCHANGE, tokenId);
    console.log(`  On-chain balance (CTF Exchange): ${exchangeBalance.toString()}`);
    console.log(`  On-chain balance (NegRisk Exchange): ${negRiskBalance.toString()}`);

    if (balance.gt(0)) {
      console.log(`\n  → Tokens ARE in wallet. Redeeming via CTF.redeemPositions...`);

      try {
        // Exactly per docs: redeemPositions(USDC_E, 0x0, conditionId, [1, 2])
        // Burns ALL tokens for this condition, no amount needed
        const tx = await ctf.redeemPositions(
          USDC_E,
          ethers.constants.HashZero,
          p.conditionId,
          [1, 2],
          {
            gasLimit: 500000,
            maxFeePerGas: feeData.maxFeePerGas?.mul(2) || ethers.utils.parseUnits('50', 'gwei'),
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(2) || ethers.utils.parseUnits('30', 'gwei'),
          }
        );
        console.log(`  TX: ${tx.hash}`);
        console.log(`  Waiting for confirmation...`);
        const receipt = await tx.wait();
        console.log(`  ✅ REDEEMED! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
      } catch (err: any) {
        console.log(`  ❌ Redeem failed: ${err.reason || err.message?.slice(0, 200)}`);

        // Check if this is a NegRisk market — try adapter
        if (err.message?.includes('CALL_EXCEPTION') || err.message?.includes('revert')) {
          console.log(`  → Trying NegRisk Adapter...`);
          try {
            const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
              'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
            ], wallet);

            const amounts = p.outcomeIndex === 0
              ? [balance, ethers.BigNumber.from(0)]
              : [ethers.BigNumber.from(0), balance];

            const tx = await adapter.redeemPositions(p.conditionId, amounts, {
              gasLimit: 500000,
              maxFeePerGas: feeData.maxFeePerGas?.mul(2) || ethers.utils.parseUnits('50', 'gwei'),
              maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(2) || ethers.utils.parseUnits('30', 'gwei'),
            });
            console.log(`  TX: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`  ✅ REDEEMED via NegRisk! Block: ${receipt.blockNumber}`);
          } catch (err2: any) {
            console.log(`  ❌ NegRisk also failed: ${err2.reason || err2.message?.slice(0, 200)}`);
          }
        }
      }
    } else {
      console.log(`\n  → Tokens NOT in wallet (balance=0).`);
      console.log(`  → They may be held by the exchange contract.`);
      console.log(`  → Polymarket should auto-settle. Check back later or use UI.`);
    }
    console.log('');
  }

  // Final balance
  const usdcAfter = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`USDC.e before: $${usdcBefore.toFixed(6)}`);
  console.log(`USDC.e after:  $${usdcAfter.toFixed(6)}`);
  console.log(`Gained:        $${(usdcAfter - usdcBefore).toFixed(6)}`);
  console.log(`═══════════════════════════════════════════════════════\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
