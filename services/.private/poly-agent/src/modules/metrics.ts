import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { PolyAgentPosition } from '../db/models/PolyAgentPosition';
import { PolyAgentTrade } from '../db/models/PolyAgentTrade';

/**
 * Metrics - Dashboard and summary statistics
 *
 * Tracks:
 * - Positions monitored, copied, skipped
 * - Trades executed, partial, failed
 * - Capital deployed, remaining
 * - PnL (trader vs ours)
 * - Drift metrics
 */

interface MetricsSummary {
  // Positions
  positionsMonitored: number;
  positionsCopied: number;
  positionsSkipped: number;
  positionsUnderwater: number;
  positionsSynced: number;

  // Trades
  tradesTotal: number;
  tradesExecuted: number;
  tradesPartial: number;
  tradesFailed: number;
  tradesSkipped: number;
  avgFillAttempts: number;
  fillRate: number;

  // Capital
  traderTotalValue: number;
  ourDeployed: number;
  ourRemaining: number;
  maxAllocation: number;
  allocationPercent: number;

  // PnL
  traderPnL: number;
  traderPnLPercent: number;
  ourPnL: number;
  ourPnLPercent: number;

  // Drift
  avgEntryDrift: number;
  avgTradeDrift: number;
  slippageBuffer: number;
}

export class Metrics {
  private logIntervalMs: number;
  private logTimer: NodeJS.Timer | null = null;

  constructor() {
    this.logIntervalMs = parseInt(process.env.METRICS_LOG_INTERVAL_MS || '60000');

    // Listen for events
    eventBus.on('trade:filled', this.onTradeFilled.bind(this));
    eventBus.on('trade:partial', this.onTradePartial.bind(this));
    eventBus.on('trade:failed', this.onTradeFailed.bind(this));
    eventBus.on('initial:sync:complete', this.onInitialSyncComplete.bind(this));
  }

  async initialize() {
    console.log('[Metrics] Initialized');

    // Start periodic logging
    this.logTimer = setInterval(() => {
      this.logSummary().catch((err) => {
        console.error('[Metrics] Error logging summary:', err.message);
      });
    }, this.logIntervalMs);
  }

  async shutdown() {
    if (this.logTimer) {
      clearInterval(this.logTimer);
      this.logTimer = null;
    }
  }

  /**
   * Get current metrics summary
   */
  async getSummary(): Promise<MetricsSummary> {
    // Aggregate positions
    const positions = await PolyAgentPosition.aggregate([
      {
        $match: {
          targetWallet: config.targetWallet.toLowerCase(),
          botWallet: config.botWalletAddress.toLowerCase(),
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          copied: { $sum: { $cond: [{ $in: ['$status', ['SYNCED', 'PARTIAL']] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'SKIPPED'] }, 1, 0] } },
          underwater: { $sum: { $cond: [{ $eq: ['$status', 'UNDERWATER'] }, 1, 0] } },
          synced: { $sum: { $cond: [{ $eq: ['$status', 'SYNCED'] }, 1, 0] } },
          traderValue: { $sum: '$traderValueUsdc' },
          ourValue: { $sum: '$ourValueUsdc' },
          traderPnL: { $sum: '$traderPnL' },
          ourPnL: { $sum: '$ourPnL' },
          avgEntryDrift: { $avg: '$entryDrift' },
        },
      },
    ]);

    // Aggregate trades
    const trades = await PolyAgentTrade.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          filled: { $sum: { $cond: [{ $eq: ['$status', 'FILLED'] }, 1, 0] } },
          partial: { $sum: { $cond: [{ $eq: ['$status', 'PARTIAL'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
          skipped: { $sum: { $cond: [{ $eq: ['$status', 'SKIPPED'] }, 1, 0] } },
          avgAttempts: { $avg: '$copy.attempts' },
          avgDrift: { $avg: '$copy.priceDrift' },
          totalSlippage: { $sum: '$slippageUsdc' },
        },
      },
    ]);

    const posStats = positions[0] || {
      total: 0,
      copied: 0,
      skipped: 0,
      underwater: 0,
      synced: 0,
      traderValue: 0,
      ourValue: 0,
      traderPnL: 0,
      ourPnL: 0,
      avgEntryDrift: 0,
    };

    const tradeStats = trades[0] || {
      total: 0,
      filled: 0,
      partial: 0,
      failed: 0,
      skipped: 0,
      avgAttempts: 0,
      avgDrift: 0,
      totalSlippage: 0,
    };

    const ourDeployed = posStats.ourValue || 0;
    const traderPnLPercent = posStats.traderValue > 0
      ? (posStats.traderPnL / posStats.traderValue) * 100
      : 0;
    const ourPnLPercent = ourDeployed > 0
      ? (posStats.ourPnL / ourDeployed) * 100
      : 0;

    return {
      // Positions
      positionsMonitored: posStats.total,
      positionsCopied: posStats.copied,
      positionsSkipped: posStats.skipped,
      positionsUnderwater: posStats.underwater,
      positionsSynced: posStats.synced,

      // Trades
      tradesTotal: tradeStats.total,
      tradesExecuted: tradeStats.filled,
      tradesPartial: tradeStats.partial,
      tradesFailed: tradeStats.failed,
      tradesSkipped: tradeStats.skipped,
      avgFillAttempts: tradeStats.avgAttempts || 0,
      fillRate: tradeStats.total > 0
        ? ((tradeStats.filled + tradeStats.partial) / tradeStats.total) * 100
        : 0,

      // Capital
      traderTotalValue: posStats.traderValue,
      ourDeployed,
      ourRemaining: config.maxAllocationUsdc - ourDeployed,
      maxAllocation: config.maxAllocationUsdc,
      allocationPercent: (ourDeployed / config.maxAllocationUsdc) * 100,

      // PnL
      traderPnL: posStats.traderPnL,
      traderPnLPercent,
      ourPnL: posStats.ourPnL,
      ourPnLPercent,

      // Drift
      avgEntryDrift: posStats.avgEntryDrift || 0,
      avgTradeDrift: tradeStats.avgDrift || 0,
      slippageBuffer: tradeStats.totalSlippage || 0,
    };
  }

  /**
   * Log summary dashboard to console
   */
  async logSummary() {
    const summary = await this.getSummary();

    console.log('\n┌────────────────────────────────────────────────────────────────┐');
    console.log('│              COPY TRADING METRICS DASHBOARD                    │');
    console.log('├────────────────────────────────────────────────────────────────┤');
    console.log(`│  Trader: ${config.targetWallet.slice(0, 10)}...`);
    console.log(`│  Trader Total Value: $${summary.traderTotalValue.toFixed(2).padStart(12)}`);
    console.log(`│  Our Allocation: $${summary.ourDeployed.toFixed(2)} / $${summary.maxAllocation} (${summary.allocationPercent.toFixed(1)}%)`);
    console.log('│');
    console.log('│  ┌──────────────────────────────────────────────────────────┐');
    console.log('│  │ POSITIONS                                                │');
    console.log('│  ├──────────────────────────────────────────────────────────┤');
    console.log(`│  │ Monitored: ${summary.positionsMonitored.toString().padStart(3)}  │  Copied: ${summary.positionsCopied.toString().padStart(3)}  │  Skipped: ${summary.positionsSkipped.toString().padStart(3)}`);
    console.log(`│  │ Underwater: ${summary.positionsUnderwater.toString().padStart(2)}  │  Synced: ${summary.positionsSynced.toString().padStart(3)}`);
    console.log('│  └──────────────────────────────────────────────────────────┘');
    console.log('│');
    console.log('│  ┌──────────────────────────────────────────────────────────┐');
    console.log('│  │ TRADES                                                   │');
    console.log('│  ├──────────────────────────────────────────────────────────┤');
    console.log(`│  │ Total: ${summary.tradesTotal.toString().padStart(4)}  │  Executed: ${summary.tradesExecuted.toString().padStart(4)}  │  Failed: ${summary.tradesFailed.toString().padStart(3)}`);
    console.log(`│  │ Avg Fill Attempts: ${summary.avgFillAttempts.toFixed(1)}  │  Fill Rate: ${summary.fillRate.toFixed(1)}%`);
    console.log('│  └──────────────────────────────────────────────────────────┘');
    console.log('│');
    console.log('│  ┌──────────────────────────────────────────────────────────┐');
    console.log('│  │ PNL & DRIFT                                              │');
    console.log('│  ├──────────────────────────────────────────────────────────┤');
    console.log(`│  │ Trader PnL: $${summary.traderPnL.toFixed(2)} (${summary.traderPnLPercent.toFixed(2)}%)`);
    console.log(`│  │ Our PnL: $${summary.ourPnL.toFixed(2)} (${summary.ourPnLPercent.toFixed(2)}%)`);
    console.log(`│  │ Avg Entry Drift: ${summary.avgEntryDrift.toFixed(2)}%  │  Avg Trade Drift: ${summary.avgTradeDrift.toFixed(2)}%`);
    console.log(`│  │ Slippage Buffer: $${summary.slippageBuffer.toFixed(2)}`);
    console.log('│  └──────────────────────────────────────────────────────────┘');
    console.log('└────────────────────────────────────────────────────────────────┘\n');
  }

  /**
   * Get position drift table
   */
  async getPositionDriftTable(): Promise<{
    marketQuestion: string;
    outcome: string;
    traderAvg: number;
    ourAvg: number;
    drift: number;
    status: string;
  }[]> {
    const positions = await PolyAgentPosition.find({
      targetWallet: config.targetWallet.toLowerCase(),
      botWallet: config.botWalletAddress.toLowerCase(),
      ourSize: { $gt: 0 },
    })
      .sort({ ourValueUsdc: -1 })
      .limit(20)
      .lean();

    return positions.map((p) => ({
      marketQuestion: (p.marketQuestion || '').substring(0, 40),
      outcome: p.outcome || '',
      traderAvg: p.traderAvgPrice,
      ourAvg: p.ourAvgPrice,
      drift: p.priceVsTrader,
      status: p.status,
    }));
  }

  // Event handlers
  private onTradeFilled(data: any) {
    console.log(`[Metrics] Trade filled: ${data.filledSize.toFixed(4)} shares, drift: ${data.priceDrift?.toFixed(2)}%`);
  }

  private onTradePartial(data: any) {
    console.log(`[Metrics] Trade partial: ${data.filledSize.toFixed(4)} filled, ${data.remainingSize.toFixed(4)} remaining`);
  }

  private onTradeFailed(data: any) {
    console.log(`[Metrics] Trade failed: ${data.error}`);
  }

  private onInitialSyncComplete(data: any) {
    console.log(`[Metrics] Initial sync complete: ${data.positionsCopied} copied, ${data.positionsSkipped} skipped`);
  }
}
