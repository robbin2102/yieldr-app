/**
 * cancel-pending-tx.ts
 *
 * Replaces all pending (unconfirmed) transactions with zero-value self-transfers
 * at higher gas price to unblock stuck nonces.
 *
 * Run:
 *   npx tsx cancel-pending-tx.ts          — show pending nonces only
 *   npx tsx cancel-pending-tx.ts --execute — send replacement (cancel) TXs
 */

import { ethers } from 'ethers';
import { config } from './src/config';

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  console.log(`\nWallet: ${config.botWalletAddress}`);
  console.log(`Mode  : ${DRY_RUN ? 'DRY RUN' : '⚡ EXECUTE'}\n`);

  const provider = new ethers.providers.StaticJsonRpcProvider(config.polygonRpcUrl, {
    name: 'polygon', chainId: config.chainId,
  });
  const wallet = new ethers.Wallet(config.botPrivateKey, provider);

  const confirmedNonce = await provider.getTransactionCount(config.botWalletAddress, 'latest');
  const pendingNonce   = await provider.getTransactionCount(config.botWalletAddress, 'pending');

  console.log(`Confirmed nonce : ${confirmedNonce}`);
  console.log(`Pending nonce   : ${pendingNonce}`);

  if (pendingNonce === confirmedNonce) {
    console.log('\nNo pending transactions. Nothing to cancel.\n');
    return;
  }

  console.log(`\nFound ${pendingNonce - confirmedNonce} pending TX(s) at nonce(s) ${confirmedNonce}..${pendingNonce - 1}\n`);

  if (DRY_RUN) {
    console.log('Dry run — add --execute to send cancellation TXs.\n');
    return;
  }

  // Use live gas + generous headroom to beat the stuck TX
  const feeData = await provider.getFeeData();
  const FLOOR_PRIORITY = ethers.utils.parseUnits('50', 'gwei');
  const FLOOR_MAX      = ethers.utils.parseUnits('400', 'gwei');
  const estimatedPriority = feeData.maxPriorityFeePerGas ?? ethers.constants.Zero;
  const estimatedMax      = feeData.maxFeePerGas         ?? ethers.constants.Zero;
  // Must be >10% higher than stuck TX to replace it
  const priorityFee = estimatedPriority.gt(FLOOR_PRIORITY) ? estimatedPriority.mul(120).div(100) : FLOOR_PRIORITY;
  const maxFee      = estimatedMax.gt(FLOOR_MAX)           ? estimatedMax.mul(120).div(100)       : FLOOR_MAX;

  console.log(`Gas: priority=${ethers.utils.formatUnits(priorityFee, 'gwei')} Gwei  max=${ethers.utils.formatUnits(maxFee, 'gwei')} Gwei\n`);

  for (let nonce = confirmedNonce; nonce < pendingNonce; nonce++) {
    console.log(`  Cancelling nonce ${nonce} (0-value self-transfer)...`);
    try {
      const tx = await wallet.sendTransaction({
        to:                   config.botWalletAddress,
        value:                0,
        nonce,
        gasLimit:             21_000,
        maxPriorityFeePerGas: priorityFee,
        maxFeePerGas:         maxFee,
      });
      console.log(`    TX submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      console.log(`    ✅ Confirmed block ${receipt.blockNumber} — nonce ${nonce} cleared\n`);
    } catch (err: any) {
      console.error(`    ❌ Failed: ${err.message}\n`);
    }
  }

  console.log('Done. Re-run redeem-positions.ts --execute to retry redemptions.\n');
}

main().catch(console.error);
