/**
 * Redeem Final — Try CTF.redeemPositions with legacy gas
 *
 * NegRisk adapter requires both sides. CTF redeemPositions should
 * work with [1,2] indexSets per the docs — burns winning side for USDC,
 * burns losing side for $0.
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

async function main() {
  console.log('\n═══ REDEEM FINAL — CTF with Legacy Gas ═══\n');
  console.log(`Wallet: ${wallet.address}`);

  const ctf = new ethers.Contract(CTF, [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  ], wallet);

  const usdc = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
  const usdcBefore = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`USDC.e before: $${usdcBefore.toFixed(6)}\n`);

  const gasPrice = await provider.getGasPrice();
  const highGas = gasPrice.mul(3);
  console.log(`Gas price: ${ethers.utils.formatUnits(highGas, 'gwei')} gwei (3x current)\n`);

  // Winning positions
  const winners = [
    {
      title: 'BTC Mar 28 2:05-2:10 Up',
      conditionId: '0xe5e20977ec4756b74ec4848e11356b5fa0027f8583d7aeec9b787c5074b0b046',
      asset: '27128686821663539950268995807021822806199821612025029842352468741058016375284',
    },
    {
      title: 'BTC Mar 28 3:55-4:00 Up',
      conditionId: '0x2f76c1755ecdfc95ab131d887423ce5759a88486302d8a51925729331a6232ae',
      asset: '46966419946891454890259067249902221465363680043949083376163945996344034345983',
    },
    {
      title: 'BTC Mar 29 6:15-6:20 Down',
      conditionId: '0xd865f47b0e6a124ff45a4706dffaabe8c28ddc35925ab39d4856e809677d0a81',
      asset: '52049323660571896522848961340408001818332468983321240635162494196834890435897',
    },
  ];

  // Only test first one
  const toRedeem = winners.slice(0, 1);

  for (const w of toRedeem) {
    console.log(`═══ ${w.title} ═══`);
    console.log(`  conditionId: ${w.conditionId}`);

    const bal = await ctf.balanceOf(wallet.address, w.asset);
    console.log(`  Token balance: ${bal.toString()} (${(parseInt(bal.toString()) / 1e6).toFixed(6)})`);

    if (bal.isZero()) {
      console.log(`  ⚠️ No balance — skip\n`);
      continue;
    }

    // Approach 1: CTF.redeemPositions per docs
    // indexSets [1,2] means redeem both outcomes
    console.log(`\n  [Approach 1] CTF.redeemPositions(USDC_E, 0x0, conditionId, [1,2]) — legacy gas`);
    try {
      const tx = await ctf.redeemPositions(
        USDC_E,
        ethers.constants.HashZero,
        w.conditionId,
        [1, 2],
        { gasLimit: 300000, gasPrice: highGas }
      );
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  ✅ SUCCESS! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);

      const newBal = await ctf.balanceOf(wallet.address, w.asset);
      console.log(`  Token balance after: ${newBal.toString()}`);
    } catch (err: any) {
      console.log(`  ❌ Failed.`);
      console.log(`  Code: ${err.code}`);
      console.log(`  Reason: ${err.reason}`);
      console.log(`  Message: ${err.message?.slice(0, 300)}`);

      // Check if it's a gas issue or contract revert
      if (err.message?.includes('CALL_EXCEPTION')) {
        console.log(`  → Contract reverted on-chain. Checking revert reason on Polygonscan...`);
        console.log(`  → TX hash: ${err.transactionHash || 'check above'}`);
      }
    }

    // Approach 2: CTF.redeemPositions with just winning side [1] or [2]
    const balCheck = await ctf.balanceOf(wallet.address, w.asset);
    if (balCheck.gt(0)) {
      console.log(`\n  [Approach 2] CTF.redeemPositions with single indexSet [1]`);
      try {
        const tx = await ctf.redeemPositions(
          USDC_E,
          ethers.constants.HashZero,
          w.conditionId,
          [1],
          { gasLimit: 300000, gasPrice: highGas }
        );
        console.log(`  TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`  ✅ SUCCESS! Block: ${receipt.blockNumber}`);
      } catch (err: any) {
        console.log(`  ❌ [1] failed: ${err.reason || err.message?.slice(0, 150)}`);

        // Try [2]
        console.log(`\n  [Approach 2b] CTF.redeemPositions with indexSet [2]`);
        try {
          const tx = await ctf.redeemPositions(
            USDC_E,
            ethers.constants.HashZero,
            w.conditionId,
            [2],
            { gasLimit: 300000, gasPrice: highGas }
          );
          console.log(`  TX: ${tx.hash}`);
          const receipt = await tx.wait();
          console.log(`  ✅ SUCCESS! Block: ${receipt.blockNumber}`);
        } catch (err2: any) {
          console.log(`  ❌ [2] also failed: ${err2.reason || err2.message?.slice(0, 150)}`);
        }
      }
    }

    // Approach 3: Try with a different parentCollectionId (NegRisk uses non-zero)
    const balCheck2 = await ctf.balanceOf(wallet.address, w.asset);
    if (balCheck2.gt(0)) {
      console.log(`\n  [Approach 3] Maybe NegRisk uses a non-zero parentCollectionId?`);
      console.log(`  → This market is NegRisk. The parentCollectionId might NOT be 0x0.`);
      console.log(`  → Need to find the correct parentCollectionId from the NegRisk contract.`);
      console.log(`  → For now, try Polymarket UI or wait for auto-settlement.`);
    }

    console.log('');
  }

  const usdcAfter = parseInt((await usdc.balanceOf(wallet.address)).toString()) / 1e6;
  console.log(`═══════════════════════════════════════════`);
  console.log(`USDC.e: $${usdcBefore.toFixed(6)} → $${usdcAfter.toFixed(6)} (${usdcAfter > usdcBefore ? '+' : ''}$${(usdcAfter - usdcBefore).toFixed(6)})`);
  console.log(`═══════════════════════════════════════════\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
