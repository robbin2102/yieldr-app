import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { orderbookCache } from '../state/orderbookCache';
import { PolyAgentPosition } from '../db/models/PolyAgentPosition';
import PolymarketOpenPosition from '../../../../../models/PolymarketOpenPosition';

/**
 * Initial Position Copier
 *
 * On startup:
 * 1. Fetch trader's open positions via /positions API
 * 2. Check our MongoDB for existing mirrored positions
 * 3. Calculate drift and pro-rata allocation
 * 4. Execute FAK orders with retry for positions within drift threshold
 *
 * Drift logic:
 * - New positions: copy if |drift| < DRIFT_THRESHOLD_NEW (10%)
 * - Existing positions: sync difference if |drift| < DRIFT_THRESHOLD_EXISTING (20%)
 * - Underwater positions: skip if drift < DRIFT_THRESHOLD_UNDERWATER (-10%)
 */

interface TraderPosition {
  asset: string;           // tokenId
  conditionId: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;    // size * avgPrice
  currentValue: number;    // size * curPrice
  cashPnl: number;
  percentPnl: number;
  outcome: string;
  title: string;           // market question
  slug: string;
}

interface SyncResult {
  positionsAnalyzed: number;
  positionsCopied: number;
  positionsSkipped: number;
  positionsUnderwater: number;
  positionsSynced: number;
  totalTraderValue: number;
  totalOurValue: number;
  proRataRatio: number;
  durationMs: number;
}

export class InitialCopier {
  private clobClient: ClobClient;

  constructor(clobClient: ClobClient) {
    this.clobClient = clobClient;
  }

  /**
   * Calculate drift percentage
   * drift = (currentPrice - avgPrice) / avgPrice * 100
   */
  private calculateDrift(avgPrice: number, currentPrice: number): number {
    if (avgPrice === 0) return 0;
    return ((currentPrice - avgPrice) / avgPrice) * 100;
  }

  /**
   * Fetch trader's open positions from Polymarket API
   */
  private async fetchTraderPositions(walletAddress: string): Promise<TraderPosition[]> {
    console.log(`[InitialCopier] Fetching positions for ${walletAddress.slice(0, 10)}...`);

    const response = await fetch(
      `${config.dataApiBase}/positions?user=${walletAddress}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch positions: ${response.status}`);
    }

    const positions = await response.json() as any[];

    // Filter for active positions with size > 0
    const activePositions = positions.filter((p) => p.size > 0);

    console.log(`[InitialCopier] Found ${activePositions.length} active positions`);

    return activePositions.map((p) => ({
      asset: p.asset,
      conditionId: p.conditionId,
      size: parseFloat(p.size) || 0,
      avgPrice: parseFloat(p.avgPrice) || 0,
      curPrice: parseFloat(p.curPrice) || 0,
      initialValue: parseFloat(p.initialValue) || 0,
      currentValue: parseFloat(p.currentValue) || 0,
      cashPnl: parseFloat(p.cashPnl) || 0,
      percentPnl: parseFloat(p.percentPnl) || 0,
      outcome: p.outcome || '',
      title: p.title || '',
      slug: p.slug || '',
    }));
  }

  /**
   * Check if position exists in our MongoDB (polymarket-openPositions)
   */
  private async getOurExistingPosition(tokenId: string): Promise<{
    size: number;
    avgPrice: number;
  } | null> {
    try {
      const position = await PolymarketOpenPosition.findOne({
        walletAddress: config.botWalletAddress.toLowerCase(),
        asset: tokenId,
      }).lean();

      if (position && position.size > 0) {
        return {
          size: position.size,
          avgPrice: position.avgPrice || 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Execute FAK order with retry for 100% fills
   */
  private async executeWithRetry(
    side: 'BUY' | 'SELL',
    tokenId: string,
    targetSize: number
  ): Promise<{
    success: boolean;
    filledSize: number;
    avgPrice: number;
    attempts: number;
    remainingSize: number;
  }> {
    let remainingSize = targetSize;
    let totalFilled = 0;
    let totalCost = 0;
    let attempts = 0;

    console.log(`[InitialCopier] Executing ${side} ${targetSize.toFixed(4)} shares with FAK...`);

    while (remainingSize > 0.01 && attempts < config.maxOrderRetries) {
      attempts++;

      // Get current best price
      const bestPrice = await orderbookCache.getBestPrice(tokenId, side);

      if (!bestPrice) {
        console.error(`[InitialCopier] Failed to get best price for ${tokenId}`);
        break;
      }

      console.log(`[InitialCopier] Attempt ${attempts}: ${side} ${remainingSize.toFixed(4)} @ $${bestPrice.toFixed(4)}`);

      try {
        // Create order based on side
        let order;
        const orderCost = remainingSize * bestPrice;

        if (side === 'BUY') {
          // BUY: amount in USDC
          order = await this.clobClient.createMarketBuyOrder({
            tokenID: tokenId,
            amount: Math.max(orderCost, 1), // Min $1 for buy orders
            price: bestPrice,
            feeRateBps: 0,
            nonce: 0,
          });
        } else {
          // SELL: size in shares
          order = await this.clobClient.createOrder({
            tokenID: tokenId,
            price: bestPrice,
            size: remainingSize,
            side: Side.SELL,
            feeRateBps: 0,
            nonce: 0,
          });
        }

        // Submit as FAK (Fill-And-Kill)
        const response = await this.clobClient.postOrder(order, OrderType.FAK);

        if (response && response.orderID) {
          // Wait for fill status
          const fill = await this.waitForFill(response.orderID, side === 'BUY' ? orderCost : remainingSize);

          if (fill.filledSize > 0) {
            totalFilled += fill.filledSize;
            totalCost += fill.filledSize * fill.avgPrice;
            remainingSize -= fill.filledSize;

            console.log(`[InitialCopier] Filled ${fill.filledSize.toFixed(4)} @ $${fill.avgPrice.toFixed(4)} (remaining: ${remainingSize.toFixed(4)})`);
          }
        }
      } catch (error: any) {
        console.error(`[InitialCopier] Order attempt ${attempts} failed:`, error.message);
      }

      // Wait before retry if needed
      if (remainingSize > 0.01 && attempts < config.maxOrderRetries) {
        await this.sleep(config.orderRetryDelayMs);
      }
    }

    const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;

    return {
      success: remainingSize < 0.01,
      filledSize: totalFilled,
      avgPrice,
      attempts,
      remainingSize,
    };
  }

  /**
   * Wait for order fill status
   */
  private async waitForFill(orderId: string, expectedSize: number): Promise<{
    filledSize: number;
    avgPrice: number;
  }> {
    // Simple polling for fill status
    const maxAttempts = 10;
    const pollInterval = 200; // 200ms

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(
          `${config.clobApiBase}/order/${orderId}`,
          {
            headers: {
              'POLY_API_KEY': config.apiKey,
              'POLY_SIGNATURE': config.apiSecret,
              'POLY_TIMESTAMP': Date.now().toString(),
              'POLY_PASSPHRASE': config.passphrase,
            },
          }
        );

        if (response.ok) {
          const order = await response.json() as any;

          if (order.status === 'MATCHED' || order.status === 'FILLED') {
            return {
              filledSize: parseFloat(order.size_matched) || 0,
              avgPrice: parseFloat(order.price) || 0,
            };
          }

          if (order.status === 'CANCELED' || order.status === 'EXPIRED') {
            return {
              filledSize: parseFloat(order.size_matched) || 0,
              avgPrice: parseFloat(order.price) || 0,
            };
          }
        }
      } catch {
        // Continue polling
      }

      await this.sleep(pollInterval);
    }

    return { filledSize: 0, avgPrice: 0 };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Main sync function - runs on startup
   */
  async syncPositions(): Promise<SyncResult> {
    const startTime = Date.now();

    console.log('\n[InitialCopier] ═══════════════════════════════════════════════════════════════');
    console.log('[InitialCopier]              INITIAL POSITION SYNC                              ');
    console.log('[InitialCopier] ═══════════════════════════════════════════════════════════════');
    console.log(`[InitialCopier] Target wallet: ${config.targetWallet}`);
    console.log(`[InitialCopier] Bot wallet: ${config.botWalletAddress}`);
    console.log(`[InitialCopier] Max allocation: $${config.maxAllocationUsdc}`);
    console.log(`[InitialCopier] Drift threshold (new): ${config.driftThresholdNew}%`);
    console.log(`[InitialCopier] Drift threshold (existing): ${config.driftThresholdExisting}%`);
    console.log('[InitialCopier] ═══════════════════════════════════════════════════════════════\n');

    // Fetch trader's positions
    const traderPositions = await this.fetchTraderPositions(config.targetWallet);

    if (traderPositions.length === 0) {
      console.log('[InitialCopier] No active positions found for trader');
      return {
        positionsAnalyzed: 0,
        positionsCopied: 0,
        positionsSkipped: 0,
        positionsUnderwater: 0,
        positionsSynced: 0,
        totalTraderValue: 0,
        totalOurValue: 0,
        proRataRatio: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Calculate total trader value for pro-rata allocation
    const totalTraderValue = traderPositions.reduce((sum, p) => sum + p.currentValue, 0);
    const proRataRatio = config.maxAllocationUsdc / totalTraderValue;

    console.log(`[InitialCopier] Trader total value: $${totalTraderValue.toFixed(2)}`);
    console.log(`[InitialCopier] Pro-rata ratio: ${(proRataRatio * 100).toFixed(4)}%`);
    console.log(`[InitialCopier] Our target allocation: $${config.maxAllocationUsdc}\n`);

    let positionsCopied = 0;
    let positionsSkipped = 0;
    let positionsUnderwater = 0;
    let positionsSynced = 0;
    let totalOurValue = 0;

    // Process each position
    for (let i = 0; i < traderPositions.length; i++) {
      const traderPos = traderPositions[i];
      const posNum = i + 1;

      console.log(`\n[InitialCopier] [${posNum}/${traderPositions.length}] ${traderPos.title.substring(0, 50)}...`);
      console.log(`[InitialCopier]   Outcome: ${traderPos.outcome}`);
      console.log(`[InitialCopier]   Trader: ${traderPos.size.toFixed(2)} shares @ $${traderPos.avgPrice.toFixed(4)}`);
      console.log(`[InitialCopier]   Current: $${traderPos.curPrice.toFixed(4)} | Value: $${traderPos.currentValue.toFixed(2)}`);

      // Calculate drift
      const drift = this.calculateDrift(traderPos.avgPrice, traderPos.curPrice);
      console.log(`[InitialCopier]   Drift: ${drift.toFixed(2)}%`);

      // Check for underwater position
      if (drift < config.driftThresholdUnderwater) {
        console.log(`[InitialCopier]   ⏭️ SKIP: Position underwater (drift ${drift.toFixed(2)}% < ${config.driftThresholdUnderwater}%)`);

        await this.savePosition(traderPos, 0, 0, 0, 'UNDERWATER', `Underwater: drift ${drift.toFixed(2)}%`);
        positionsUnderwater++;
        continue;
      }

      // Check our existing position
      const ourPosition = await this.getOurExistingPosition(traderPos.asset);
      const ourCurrentSize = ourPosition?.size || 0;

      // Calculate target size (pro-rata)
      const targetSize = traderPos.size * proRataRatio;
      const sizeDiff = targetSize - ourCurrentSize;

      console.log(`[InitialCopier]   Target size: ${targetSize.toFixed(4)} shares`);
      console.log(`[InitialCopier]   Our current: ${ourCurrentSize.toFixed(4)} shares`);
      console.log(`[InitialCopier]   Difference: ${sizeDiff.toFixed(4)} shares`);

      if (ourCurrentSize === 0) {
        // NEW POSITION - use new drift threshold
        if (Math.abs(drift) > config.driftThresholdNew) {
          console.log(`[InitialCopier]   ⏭️ SKIP: Drift too high for new position (${Math.abs(drift).toFixed(2)}% > ${config.driftThresholdNew}%)`);

          await this.savePosition(traderPos, 0, 0, drift, 'SKIPPED', `Drift too high: ${drift.toFixed(2)}%`);
          positionsSkipped++;
          continue;
        }

        // Execute buy order
        console.log(`[InitialCopier]   ✅ COPY: New position within drift threshold`);

        const result = await this.executeWithRetry('BUY', traderPos.asset, targetSize);

        if (result.success) {
          console.log(`[InitialCopier]   ✅ FILLED: ${result.filledSize.toFixed(4)} shares @ $${result.avgPrice.toFixed(4)} (${result.attempts} attempts)`);

          const entryDrift = this.calculateDrift(traderPos.avgPrice, result.avgPrice);
          await this.savePosition(traderPos, result.filledSize, result.avgPrice, entryDrift, 'SYNCED');

          totalOurValue += result.filledSize * result.avgPrice;
          positionsCopied++;
        } else {
          console.log(`[InitialCopier]   ⚠️ PARTIAL: ${result.filledSize.toFixed(4)}/${targetSize.toFixed(4)} filled`);

          await this.savePosition(traderPos, result.filledSize, result.avgPrice, drift, 'PARTIAL');
          positionsCopied++;
        }
      } else if (sizeDiff > 0.01) {
        // EXISTING POSITION - need to increase, use existing drift threshold
        if (Math.abs(drift) > config.driftThresholdExisting) {
          console.log(`[InitialCopier]   ⏭️ SKIP: Drift too high for size sync (${Math.abs(drift).toFixed(2)}% > ${config.driftThresholdExisting}%)`);

          await this.savePosition(traderPos, ourCurrentSize, ourPosition?.avgPrice || 0, drift, 'SKIPPED', `Drift too high for sync: ${drift.toFixed(2)}%`);
          positionsSkipped++;
          continue;
        }

        // Execute buy for difference
        console.log(`[InitialCopier]   ✅ SYNC: Increasing position by ${sizeDiff.toFixed(4)} shares`);

        const result = await this.executeWithRetry('BUY', traderPos.asset, sizeDiff);

        if (result.success || result.filledSize > 0) {
          console.log(`[InitialCopier]   ✅ FILLED: ${result.filledSize.toFixed(4)} shares @ $${result.avgPrice.toFixed(4)}`);

          // Calculate new average price
          const totalShares = ourCurrentSize + result.filledSize;
          const newAvgPrice = ((ourCurrentSize * (ourPosition?.avgPrice || 0)) + (result.filledSize * result.avgPrice)) / totalShares;

          await this.savePosition(traderPos, totalShares, newAvgPrice, drift, result.success ? 'SYNCED' : 'PARTIAL');

          totalOurValue += result.filledSize * result.avgPrice;
          positionsSynced++;
        }
      } else {
        // Position already synced
        console.log(`[InitialCopier]   ✓ SYNCED: Position already at target size`);

        await this.savePosition(traderPos, ourCurrentSize, ourPosition?.avgPrice || 0, drift, 'SYNCED');
        positionsSynced++;
        totalOurValue += ourCurrentSize * traderPos.curPrice;
      }
    }

    const durationMs = Date.now() - startTime;

    // Log summary
    console.log('\n[InitialCopier] ═══════════════════════════════════════════════════════════════');
    console.log('[InitialCopier]              INITIAL SYNC COMPLETE                              ');
    console.log('[InitialCopier] ═══════════════════════════════════════════════════════════════');
    console.log(`[InitialCopier] Positions analyzed: ${traderPositions.length}`);
    console.log(`[InitialCopier] Positions copied (new): ${positionsCopied}`);
    console.log(`[InitialCopier] Positions synced (existing): ${positionsSynced}`);
    console.log(`[InitialCopier] Positions skipped: ${positionsSkipped}`);
    console.log(`[InitialCopier] Positions underwater: ${positionsUnderwater}`);
    console.log(`[InitialCopier] Trader total value: $${totalTraderValue.toFixed(2)}`);
    console.log(`[InitialCopier] Our deployed value: $${totalOurValue.toFixed(2)}`);
    console.log(`[InitialCopier] Duration: ${(durationMs / 1000).toFixed(2)}s`);
    console.log('[InitialCopier] ═══════════════════════════════════════════════════════════════\n');

    // Emit event for metrics
    eventBus.emit('initial:sync:complete', {
      positionsAnalyzed: traderPositions.length,
      positionsCopied,
      positionsSkipped,
      positionsUnderwater,
      positionsSynced,
      totalTraderValue,
      totalOurValue,
      proRataRatio,
      durationMs,
    });

    return {
      positionsAnalyzed: traderPositions.length,
      positionsCopied,
      positionsSkipped,
      positionsUnderwater,
      positionsSynced,
      totalTraderValue,
      totalOurValue,
      proRataRatio,
      durationMs,
    };
  }

  /**
   * Save position to MongoDB
   */
  private async savePosition(
    traderPos: TraderPosition,
    ourSize: number,
    ourAvgPrice: number,
    entryDrift: number,
    status: 'SYNCED' | 'PENDING' | 'PARTIAL' | 'SKIPPED' | 'UNDERWATER' | 'CLOSED',
    skipReason?: string
  ): Promise<void> {
    try {
      const traderDrift = this.calculateDrift(traderPos.avgPrice, traderPos.curPrice);
      const ourDrift = ourAvgPrice > 0 ? this.calculateDrift(ourAvgPrice, traderPos.curPrice) : 0;
      const priceVsTrader = traderPos.avgPrice > 0 ? ((ourAvgPrice - traderPos.avgPrice) / traderPos.avgPrice) * 100 : 0;

      await PolyAgentPosition.findOneAndUpdate(
        {
          targetWallet: config.targetWallet.toLowerCase(),
          botWallet: config.botWalletAddress.toLowerCase(),
          tokenId: traderPos.asset,
        },
        {
          $set: {
            conditionId: traderPos.conditionId,
            marketQuestion: traderPos.title,
            marketSlug: traderPos.slug,
            outcome: traderPos.outcome,

            // Trader's position
            traderSize: traderPos.size,
            traderAvgPrice: traderPos.avgPrice,
            traderCurrentPrice: traderPos.curPrice,
            traderValueUsdc: traderPos.currentValue,
            traderPnL: traderPos.cashPnl,
            traderPnLPercent: traderPos.percentPnl,

            // Our position
            ourSize,
            ourAvgPrice,
            ourTargetSize: traderPos.size * (config.maxAllocationUsdc / traderPos.currentValue),
            ourValueUsdc: ourSize * traderPos.curPrice,
            ourPnL: ourSize * (traderPos.curPrice - ourAvgPrice),
            ourPnLPercent: ourAvgPrice > 0 ? ((traderPos.curPrice - ourAvgPrice) / ourAvgPrice) * 100 : 0,

            // Drift metrics
            entryDrift,
            currentDrift: ourDrift,
            priceVsTrader,

            // Status
            status,
            skipReason,
            lastSyncedAt: new Date(),
            ourEnteredAt: ourSize > 0 ? new Date() : undefined,
          },
        },
        { upsert: true, new: true }
      );
    } catch (error: any) {
      console.error(`[InitialCopier] Failed to save position: ${error.message}`);
    }
  }
}
