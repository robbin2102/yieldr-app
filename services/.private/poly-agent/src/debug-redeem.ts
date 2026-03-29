/**
 * Debug Redeem — checks on-chain token balances and tries redeem with correct amounts
 *
 * Usage:
 *   npx tsx services/.private/poly-agent/src/debug-redeem.ts
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

const CONFIG = {
  botPrivateKey: process.env.BOT_PRIVATE_KEY!,
  dataApiBase: process.env.DATA_API_BASE || 'https://data-api.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  polygonRpcUrl: process.env.POLYGON_RPC_URL!,
};

const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   Debug Redeem — Check Token Balances                 ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const provider = new ethers.providers.StaticJsonRpcProvider(CONFIG.polygonRpcUrl, { name: 'polygon', chainId: CONFIG.chainId });
  const wallet = new ethers.Wallet(CONFIG.botPrivateKey, provider);
  const ctf = new ethers.Contract(CTF, CTF_ABI, wallet);

  console.log(`Wallet: ${wallet.address}`);

  // Get current gas price
  const gasPrice = await provider.getGasPrice();
  console.log(`Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei\n`);

  // Check approvals
  const approvedCTF = await ctf.isApprovedForAll(wallet.address, '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E');
  const approvedNeg = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
  console.log(`CTF approved for CTF_Exchange: ${approvedCTF}`);
  console.log(`CTF approved for NegRisk Adapter: ${approvedNeg}\n`);

  // Fetch winning positions
  const posRes = await fetch(`${CONFIG.dataApiBase}/positions?user=${wallet.address.toLowerCase()}&sizeThreshold=0.01&limit=50`);
  const positions = posRes.ok ? await posRes.json() as any[] : [];
  const winners = positions.filter((p: any) => p.curPrice >= 0.99);

  console.log(`Found ${winners.length} winning positions\n`);

  for (const p of winners) {
    console.log(`═══ ${p.title?.slice(0, 50)} ═══`);
    console.log(`  outcome: ${p.outcome} | outcomeIndex: ${p.outcomeIndex}`);
    console.log(`  size (API): ${p.size}`);
    console.log(`  asset (tokenId): ${p.asset}`);
    console.log(`  conditionId: ${p.conditionId}`);

    // Check on-chain ERC1155 balance for this token
    try {
      const tokenId = ethers.BigNumber.from(p.asset);
      const onChainBalance = await ctf.balanceOf(wallet.address, tokenId);
      console.log(`  On-chain CTF balance: ${onChainBalance.toString()} (raw)`);
      console.log(`  On-chain CTF balance: ${ethers.utils.formatUnits(onChainBalance, 6)} (6 decimals)`);
      console.log(`  On-chain CTF balance: ${ethers.utils.formatUnits(onChainBalance, 0)} (no decimals)`);

      if (onChainBalance.gt(0)) {
        console.log(`\n  ✅ Has tokens on-chain. Attempting redeem...`);

        // Try CTF redeemPositions with correct gas price
        // For NegRisk markets, we need to call the adapter
        // But first let's try CTF directly with both indexSets
        try {
          const highGas = gasPrice.mul(200).div(100); // 2x current gas price
          console.log(`  Using gas price: ${ethers.utils.formatUnits(highGas, 'gwei')} gwei`);

          // redeemPositions needs: collateralToken, parentCollectionId, conditionId, indexSets
          // indexSets: [1] for outcome 0, [2] for outcome 1, [1,2] for both
          const tx = await ctf.redeemPositions(
            USDC_E,
            ethers.constants.HashZero, // parentCollectionId = 0 for top-level
            p.conditionId,
            [1, 2], // Try both index sets
            {
              gasLimit: 500000,
              maxFeePerGas: highGas.mul(2),
              maxPriorityFeePerGas: highGas,
            }
          );
          console.log(`  TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`  ✅ SUCCESS! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
        } catch (err: any) {
          console.log(`  ❌ CTF redeem failed: ${err.message?.slice(0, 200)}`);

          // Try NegRisk adapter
          try {
            console.log(`\n  Trying NegRisk adapter...`);
            const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
              'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
            ], wallet);

            const highGas = gasPrice.mul(200).div(100);
            // Use actual on-chain balance as the amount
            const amounts = p.outcomeIndex === 0
              ? [onChainBalance, ethers.BigNumber.from(0)]
              : [ethers.BigNumber.from(0), onChainBalance];

            console.log(`  amounts: [${amounts[0].toString()}, ${amounts[1].toString()}]`);

            const tx = await adapter.redeemPositions(p.conditionId, amounts, {
              gasLimit: 500000,
              maxFeePerGas: highGas.mul(2),
              maxPriorityFeePerGas: highGas,
            });
            console.log(`  TX: ${tx.hash}`);
            const receipt = await tx.wait();
            console.log(`  ✅ SUCCESS! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
          } catch (err2: any) {
            console.log(`  ❌ NegRisk also failed: ${err2.message?.slice(0, 200)}`);
          }
        }
      } else {
        console.log(`  ⚠️ No tokens on-chain (balance=0). May be held by exchange contract or already redeemed.`);
      }
    } catch (err: any) {
      console.log(`  Error checking balance: ${err.message}`);
    }
    console.log('');
  }

  // Final balance check
  const usdcContract = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const finalUsdc = parseInt((await usdcContract.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`\nFinal USDC.e balance: $${finalUsdc.toFixed(6)}`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
