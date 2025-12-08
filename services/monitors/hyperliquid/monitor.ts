/**
 * Hyperliquid Monitor Service
 * Orchestrates monitoring of Hyperliquid wallets
 */

import MonitoredWallet from '@/models/MonitoredWallet';
import { fetchAndSaveRecentFills, fetchAndSavePositions } from './fetcher';
import { computeMetrics } from './metrics';

/**
 * Check a wallet for updates (called by cron job)
 */
export async function checkWallet(monitoredWallet: any) {
  const { walletAddress, lastChecked } = monitoredWallet;
  const now = new Date();

  console.log(`[Hyperliquid] Checking wallet ${walletAddress}...`);

  try {
    // 1. Fetch new fills since last check
    const lastCheckedTime = lastChecked ? lastChecked.getTime() : now.getTime() - 5 * 60 * 1000;
    const { newFills } = await fetchAndSaveRecentFills(walletAddress, lastCheckedTime);

    // 2. Fetch and update current positions
    const { marginSummary, closedCoins, currentPositions } = await fetchAndSavePositions(
      walletAddress
    );

    // 3. Recompute metrics
    await computeMetrics(walletAddress, marginSummary);

    // 4. Update next check time (5 minutes from now)
    await MonitoredWallet.updateOne(
      { _id: monitoredWallet._id },
      {
        lastChecked: now,
        nextCheck: new Date(now.getTime() + 5 * 60 * 1000) // 5 minutes
      }
    );

    console.log(
      `✓ [Hyperliquid] ${walletAddress}: ${newFills} new fills, ${closedCoins.length} closed, ${currentPositions} open`
    );

    return {
      success: true,
      newFills,
      closedPositions: closedCoins.length,
      openPositions: currentPositions
    };
  } catch (error) {
    console.error(`[Hyperliquid] Error checking wallet ${walletAddress}:`, error);

    // Still update nextCheck to avoid getting stuck
    await MonitoredWallet.updateOne(
      { _id: monitoredWallet._id },
      {
        lastChecked: now,
        nextCheck: new Date(now.getTime() + 5 * 60 * 1000)
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
