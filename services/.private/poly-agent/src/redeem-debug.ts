/**
 * Redeem Debug — full error logging for every approach
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

const RPC = process.env.POLYGON_RPC_URL!;
const PK = process.env.BOT_PRIVATE_KEY!;
const CHAIN = parseInt(process.env.CHAIN_ID || '137');

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

async function main() {
  console.log('\n═══ REDEEM DEBUG ═══\n');

  // Test 1: Basic RPC connectivity
  console.log('[1] Testing RPC connection...');
  const provider = new ethers.providers.StaticJsonRpcProvider(RPC, { name: 'polygon', chainId: CHAIN });

  try {
    const blockNum = await provider.getBlockNumber();
    console.log(`  ✅ RPC connected. Block: ${blockNum}`);
  } catch (err: any) {
    console.log(`  ❌ RPC failed: ${err.message}`);
    return;
  }

  const wallet = new ethers.Wallet(PK, provider);
  console.log(`  Wallet: ${wallet.address}`);

  // Test 2: Gas price
  console.log('\n[2] Gas price...');
  try {
    const gasPrice = await provider.getGasPrice();
    console.log(`  gasPrice (legacy): ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
    const feeData = await provider.getFeeData();
    console.log(`  maxFeePerGas: ${ethers.utils.formatUnits(feeData.maxFeePerGas || 0, 'gwei')} gwei`);
    console.log(`  maxPriorityFeePerGas: ${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas || 0, 'gwei')} gwei`);
  } catch (err: any) {
    console.log(`  ❌ ${err.message}`);
  }

  // Test 3: POL balance (for gas)
  console.log('\n[3] POL balance...');
  try {
    const bal = await provider.getBalance(wallet.address);
    console.log(`  POL: ${ethers.utils.formatEther(bal)}`);
  } catch (err: any) {
    console.log(`  ❌ ${err.message}`);
  }

  // Test 4: USDC.e balance
  console.log('\n[4] USDC.e balance...');
  try {
    const usdc = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
    const bal = await usdc.balanceOf(wallet.address);
    console.log(`  USDC.e: $${(parseInt(bal.toString()) / 1e6).toFixed(6)}`);
  } catch (err: any) {
    console.log(`  ❌ ${err.message}`);
  }

  // Test 5: CTF token balance for first winner
  console.log('\n[5] CTF token balance...');
  const ctf = new ethers.Contract(CTF, [
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved) external',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  ], wallet);

  // First winning position
  const tokenId = '27128686821663539950268995807021822806199821612025029842352468741058016375284';
  const conditionId = '0xe5e20977ec4756b74ec4848e11356b5fa0027f8583d7aeec9b787c5074b0b046';

  try {
    const bal = await ctf.balanceOf(wallet.address, tokenId);
    console.log(`  Token balance: ${bal.toString()} raw (${(parseInt(bal.toString()) / 1e6).toFixed(6)})`);
  } catch (err: any) {
    console.log(`  ❌ ${err.message}`);
  }

  // Test 6: Approval status
  console.log('\n[6] Approval status...');
  try {
    const a1 = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
    console.log(`  NegRisk Adapter: ${a1}`);
  } catch (err: any) {
    console.log(`  ❌ ${err.message}`);
  }

  // Test 7: Try setApprovalForAll with LEGACY gas (not EIP-1559)
  console.log('\n[7] Attempting setApprovalForAll with LEGACY gas...');
  try {
    const gasPrice = await provider.getGasPrice();
    const highGas = gasPrice.mul(3); // 3x current
    console.log(`  Using gasPrice: ${ethers.utils.formatUnits(highGas, 'gwei')} gwei (legacy)`);

    const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, {
      gasLimit: 100000,
      gasPrice: highGas,
    });
    console.log(`  ✅ TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  ✅ Confirmed! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
  } catch (err: any) {
    console.log(`  ❌ Legacy gas failed.`);
    console.log(`  Error code: ${err.code}`);
    console.log(`  Error reason: ${err.reason}`);
    console.log(`  Error message: ${err.message?.slice(0, 300)}`);
    if (err.error) console.log(`  Inner error: ${JSON.stringify(err.error).slice(0, 300)}`);
    if (err.transaction) console.log(`  TX data: to=${err.transaction.to} gasLimit=${err.transaction.gasLimit}`);
  }

  // Test 8: Try setApprovalForAll with EIP-1559 gas
  console.log('\n[8] Attempting setApprovalForAll with EIP-1559 gas...');
  try {
    const feeData = await provider.getFeeData();
    console.log(`  maxFeePerGas: ${ethers.utils.formatUnits(feeData.maxFeePerGas?.mul(3) || 0, 'gwei')} gwei`);
    console.log(`  maxPriorityFee: ${ethers.utils.formatUnits(feeData.maxPriorityFeePerGas?.mul(3) || 0, 'gwei')} gwei`);

    const tx = await ctf.setApprovalForAll(NEG_RISK_ADAPTER, true, {
      gasLimit: 100000,
      maxFeePerGas: feeData.maxFeePerGas?.mul(3),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas?.mul(3),
    });
    console.log(`  ✅ TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`  ✅ Confirmed! Block: ${receipt.blockNumber} Gas: ${receipt.gasUsed.toString()}`);
  } catch (err: any) {
    console.log(`  ❌ EIP-1559 failed.`);
    console.log(`  Error code: ${err.code}`);
    console.log(`  Error reason: ${err.reason}`);
    console.log(`  Error message: ${err.message?.slice(0, 300)}`);
    if (err.error) console.log(`  Inner error: ${JSON.stringify(err.error).slice(0, 300)}`);
  }

  // Test 9: Try raw RPC call to bypass ethers
  console.log('\n[9] Attempting raw RPC eth_sendTransaction...');
  try {
    const iface = new ethers.utils.Interface(['function setApprovalForAll(address operator, bool approved) external']);
    const data = iface.encodeFunctionData('setApprovalForAll', [NEG_RISK_ADAPTER, true]);

    const gasPrice = await provider.getGasPrice();
    const nonce = await provider.getTransactionCount(wallet.address);
    console.log(`  Nonce: ${nonce}`);

    const rawTx = {
      to: CTF,
      data,
      gasLimit: ethers.BigNumber.from(100000),
      gasPrice: gasPrice.mul(3),
      nonce,
      chainId: CHAIN,
    };

    const signedTx = await wallet.signTransaction(rawTx);
    console.log(`  Signed TX: ${signedTx.slice(0, 40)}...`);

    const txResponse = await provider.sendTransaction(signedTx);
    console.log(`  ✅ TX submitted: ${txResponse.hash}`);
    const receipt = await txResponse.wait();
    console.log(`  ✅ Confirmed! Block: ${receipt.blockNumber}`);
  } catch (err: any) {
    console.log(`  ❌ Raw TX failed.`);
    console.log(`  Error code: ${err.code}`);
    console.log(`  Error reason: ${err.reason}`);
    console.log(`  Full error: ${err.message?.slice(0, 500)}`);
    if (err.body) {
      try {
        const body = JSON.parse(err.body);
        console.log(`  RPC error: ${JSON.stringify(body.error).slice(0, 300)}`);
      } catch {}
    }
  }

  // Test 10: If approval succeeded, try redeem
  console.log('\n[10] Checking if approval now set...');
  try {
    const approved = await ctf.isApprovedForAll(wallet.address, NEG_RISK_ADAPTER);
    console.log(`  NegRisk Adapter approved: ${approved}`);

    if (approved) {
      console.log('\n  Attempting NegRisk redeem...');
      const adapter = new ethers.Contract(NEG_RISK_ADAPTER, [
        'function redeemPositions(bytes32 conditionId, uint256[] calldata amounts) external',
      ], wallet);

      const balance = await ctf.balanceOf(wallet.address, tokenId);
      const amounts = [balance, ethers.BigNumber.from(0)]; // Up winner = index 0

      const gasPrice = await provider.getGasPrice();
      const tx = await adapter.redeemPositions(conditionId, amounts, {
        gasLimit: 500000,
        gasPrice: gasPrice.mul(3),
      });
      console.log(`  TX: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`  ✅ REDEEMED! Block: ${receipt.blockNumber}`);

      const usdcAfter = new ethers.Contract(USDC_E, ['function balanceOf(address) view returns (uint256)'], provider);
      const bal = await usdcAfter.balanceOf(wallet.address);
      console.log(`  USDC.e now: $${(parseInt(bal.toString()) / 1e6).toFixed(6)}`);
    }
  } catch (err: any) {
    console.log(`  ❌ ${err.message?.slice(0, 300)}`);
  }

  console.log('\n═══ DEBUG COMPLETE ═══\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
