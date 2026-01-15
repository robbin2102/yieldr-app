/**
 * LP Monitor Service
 * Orchestrates monitoring of LP positions
 */

import MonitoredWallet from '@/models/MonitoredWallet';
import { fetchAndSavePositions } from './fetcher';
import { computeMetrics } from './metrics';

/**
 * Random interval between 5-30 minutes (in testing: 60s)
 */
function getRandomInterval(): number {
  if (process.env.NODE_ENV === 'production') {
    // Production: 5-30 minutes
    const minMinutes = 5;
    const maxMinutes = 30;
    const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
    return randomMinutes * 60 * 1000;
  } else {
    // Testing: 60 seconds
    return 60 * 1000;
  }
}

/**
 * Check a wallet for LP position updates (called by cron job)
 */
export async function checkWallet(monitoredWallet: any) {
  const { walletAddress } = monitoredWallet;
  const now = new Date();

  console.log(`[LP] Checking wallet ${walletAddress}...`);

  try {
    // 1. Fetch and update positions
    const {
      newPositions,
      updatedPositions,
      closedPositions,
      totalPositions
    } = await fetchAndSavePositions(walletAddress);

    // 2. Recompute metrics
    await computeMetrics(walletAddress);

    // 3. Update next check time (random interval)
    const interval = getRandomInterval();
    await MonitoredWallet.updateOne(
      { _id: monitoredWallet._id },
      {
        lastChecked: now,
        nextCheck: new Date(now.getTime() + interval)
      }
    );

    console.log(
      `✓ [LP] ${walletAddress}: ${newPositions} new, ${updatedPositions} updated, ${closedPositions} closed, ${totalPositions} total`
    );

    return {
      success: true,
      newPositions,
      updatedPositions,
      closedPositions,
      totalPositions,
      nextCheckIn: Math.round(interval / 1000 / 60) // minutes
    };
  } catch (error) {
    console.error(`[LP] Error checking wallet ${walletAddress}:`, error);

    // Still update nextCheck to avoid getting stuck
    const interval = getRandomInterval();
    await MonitoredWallet.updateOne(
      { _id: monitoredWallet._id },
      {
        lastChecked: now,
        nextCheck: new Date(now.getTime() + interval)
      }
    );

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
