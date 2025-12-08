/**
 * Hyperliquid Monitor Service
 * Orchestrates monitoring of Hyperliquid wallets
 */

import MonitoredWallet from '@/models/MonitoredWallet';
import HyperliquidFill from '@/models/HyperliquidFill';
import { fetchAndSaveRecentFills, fetchAndSavePositions, fetchAndSave30DayHistory } from './fetcher';
import { computeMetrics } from './metrics';

/**
 * Check a wallet for updates (called by cron job)
 */
export async function checkWallet(monitoredWallet: any) {
  const { walletAddress, lastChecked } = monitoredWallet;
  const now = new Date();

  console.log(`[Hyperliquid Monitor] 🔍 Checking wallet ${walletAddress}...`);

  try {
    // Check if this is the first run (no historical data yet)
    const existingFillsCount = await HyperliquidFill.countDocuments({ walletAddress });
    console.log(`[Hyperliquid Monitor] 📊 Existing fills in DB: ${existingFillsCount}`);

    let newFills = 0;
    let backfillCompleted = false;

    if (existingFillsCount === 0) {
      // FIRST RUN: Fetch 30-day history
      console.log(`[Hyperliquid Monitor] 🚀 FIRST RUN DETECTED - Starting 30-day historical backfill...`);
      console.log(`[Hyperliquid Monitor] ⏳ This may take 1-3 minutes for active traders...`);

      const backfillStart = Date.now();
      const { totalFetched, chunksFetched, stoppedReason } = await fetchAndSave30DayHistory(walletAddress);
      const backfillDuration = Date.now() - backfillStart;

      console.log(`[Hyperliquid Monitor] ✅ Backfill completed in ${(backfillDuration / 1000).toFixed(1)}s`);
      console.log(`[Hyperliquid Monitor] 📈 Fetched ${totalFetched} fills across ${chunksFetched} chunks`);
      console.log(`[Hyperliquid Monitor] 🛑 Stopped: ${stoppedReason}`);

      newFills = totalFetched;
      backfillCompleted = true;
    } else {
      // SUBSEQUENT RUNS: Only fetch new fills since last check
      console.log(`[Hyperliquid Monitor] 🔄 Incremental update - fetching new fills since last check...`);
      const lastCheckedTime = lastChecked ? lastChecked.getTime() : now.getTime() - 5 * 60 * 1000;
      const result = await fetchAndSaveRecentFills(walletAddress, lastCheckedTime);
      newFills = result.newFills;
      console.log(`[Hyperliquid Monitor] 📥 Found ${newFills} new fills`);
    }

    // 2. Fetch and update current positions
    console.log(`[Hyperliquid Monitor] 🔄 Updating current positions...`);
    const { marginSummary, closedCoins, currentPositions } = await fetchAndSavePositions(
      walletAddress
    );

    // 3. Recompute metrics
    console.log(`[Hyperliquid Monitor] 🧮 Computing metrics...`);
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
      `✅ [Hyperliquid Monitor] ${walletAddress}: ${newFills} new fills, ${closedCoins.length} closed, ${currentPositions} open`
    );

    return {
      success: true,
      newFills,
      closedPositions: closedCoins.length,
      openPositions: currentPositions,
      backfillCompleted
    };
  } catch (error) {
    console.error(`❌ [Hyperliquid Monitor] Error checking wallet ${walletAddress}:`, error);

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
