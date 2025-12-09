import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { PolyAgentReconcile } from '../db/models/PolyAgentReconcile';
import { PositionResponse } from '../types';

/**
 * Reconciler - Compares positions every 60 seconds
 *
 * Flow:
 * 1. Fetch trader's positions from Polymarket /positions API
 * 2. Fetch our positions from /positions API
 * 3. For each trader position:
 *    - Calculate expected size (trader size × copyRatio)
 *    - Compare to actual size
 * 4. If gap > 5% and > 1 share: log to MongoDB
 *
 * Note: v1 only LOGS gaps, does not auto-fix them
 */
export class Reconciler {
  private intervalId: NodeJS.Timer | null = null;

  start() {
    console.log(`[Reconciler] Starting ${config.reconcilerIntervalMs}ms position checks`);

    this.intervalId = setInterval(() => {
      this.reconcile().catch((error) => {
        console.error('[Reconciler] Error:', error);
      });
    }, config.reconcilerIntervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[Reconciler] Stopped');
    }
  }

  async reconcile() {
    console.log('\n[Reconciler] Checking positions...');
    const checkedAt = new Date();

    try {
      // Fetch trader's positions
      const traderResponse = await fetch(
        `${config.dataApiBase}/positions?user=${config.targetWallet}`
      );

      if (!traderResponse.ok) {
        console.error(`[Reconciler] Trader API error: ${traderResponse.status}`);
        return;
      }

      const traderPositions: PositionResponse[] = await traderResponse.json();

      // Fetch our positions
      const ourResponse = await fetch(
        `${config.dataApiBase}/positions?user=${config.botWalletAddress}`
      );

      if (!ourResponse.ok) {
        console.error(`[Reconciler] Bot API error: ${ourResponse.status}`);
        return;
      }

      const ourPositions: PositionResponse[] = await ourResponse.json();

      // Build lookup map for our positions
      const ourPositionMap = new Map<string, PositionResponse>();
      for (const pos of ourPositions) {
        ourPositionMap.set(pos.conditionId, pos);
      }

      // Compare positions
      const gaps: any[] = [];

      for (const traderPos of traderPositions) {
        const expectedSize = traderPos.size * config.copyRatio;
        const ourPos = ourPositionMap.get(traderPos.conditionId);
        const actualSize = ourPos?.size || 0;

        const gapSize = expectedSize - actualSize;
        const gapPercent = expectedSize > 0 ? (Math.abs(gapSize) / expectedSize) * 100 : 0;

        // Only log if gap > 5% and > 1 share
        if (gapPercent > 5 && Math.abs(gapSize) >= 1) {
          const gapRecord = {
            checkedAt,
            conditionId: traderPos.conditionId,
            title: traderPos.title,
            outcome: traderPos.outcome,
            traderPosition: {
              size: traderPos.size,
              avgPrice: traderPos.avgPrice,
            },
            expectedPosition: {
              size: expectedSize,
            },
            actualPosition: {
              size: actualSize,
              avgPrice: ourPos?.avgPrice || 0,
            },
            gapSize,
            gapPercent,
            gapDirection: gapSize > 0 ? 'UNDER' : 'OVER',
          };

          gaps.push(gapRecord);

          console.log(`[Reconciler] ⚠️ Position gap detected:`);
          console.log(`  Market: ${traderPos.title} (${traderPos.outcome})`);
          console.log(`  Trader: ${traderPos.size} | Expected: ${expectedSize.toFixed(2)} | Actual: ${actualSize}`);
          console.log(`  Gap: ${gapSize.toFixed(2)} shares (${gapPercent.toFixed(1)}%)`);
        }
      }

      // Log all gaps to MongoDB
      if (gaps.length > 0) {
        await PolyAgentReconcile.insertMany(gaps);
        console.log(`[Reconciler] Logged ${gaps.length} position gap(s)`);
      } else {
        console.log('[Reconciler] ✅ All positions in sync');
      }

      eventBus.emit('reconcile:complete', { checkedAt, gapsFound: gaps.length });

    } catch (error) {
      console.error('[Reconciler] Error:', error);
    }
  }
}
