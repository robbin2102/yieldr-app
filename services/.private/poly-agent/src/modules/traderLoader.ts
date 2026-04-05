import { CopyTrader, ICopyTrader } from '../db/models/CopyTrader';

/**
 * TraderLoader — reads active traders from ahf-copyTraders.
 *
 * Provides:
 *   - getActive()          fresh DB read of all active traders
 *   - get(wallet)          single trader by wallet
 *   - updateLastSeen()     advance the activity cursor after each poll
 *   - recordSkip()         increment skip counters
 *   - recordFill()         increment fill counter + add to spentUsdc
 *   - updateLastPolled()   timestamp of last poll for this trader
 */
export class TraderLoader {
  /**
   * Returns all active traders. Fresh DB read every call — callers should
   * cache the result for the duration of a single poll cycle if needed.
   */
  static async getActive(): Promise<ICopyTrader[]> {
    return (await CopyTrader.find({ active: true }).lean()) as unknown as ICopyTrader[];
  }

  static async get(wallet: string): Promise<ICopyTrader | null> {
    return (await CopyTrader.findOne({ wallet: wallet.toLowerCase() }).lean()) as unknown as ICopyTrader | null;
  }

  /**
   * Advance the cursor so next poll only fetches new activities.
   * Only advances forward — never moves cursor backwards.
   */
  static async updateLastSeen(wallet: string, ts: number): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase(), lastSeenTs: { $lt: ts } },
      { $set: { lastSeenTs: ts } }
    );
  }

  static async updateLastPolled(wallet: string): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: { lastPolledAt: new Date() } }
    );
  }

  /**
   * Increment skip counters. Called after every skipped trade.
   */
  static async recordSkip(wallet: string, reason: string): Promise<void> {
    // Note: tradesDetected is incremented by recordDetected() before bet sizing.
    // recordSkip() must NOT increment it again — that caused every skipped trade
    // to count as 2 detections, inflating the det: stat in hourly reports.
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      {
        $inc: {
          tradesSkipped: 1,
          [`skipReasonCounts.${reason}`]: 1,
        },
      }
    );
  }

  /**
   * Increment detected counter only (before bet sizing decision).
   * Called once per detected TRADE activity.
   */
  static async recordDetected(wallet: string): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $inc: { tradesDetected: 1 } }
    );
  }

  /**
   * Increment above-avg counter (trade passed the avgBet filter).
   */
  static async recordAboveAvg(wallet: string): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $inc: { tradesAboveAvg: 1 } }
    );
  }

  /**
   * Record a successful fill: increment executed counter and add to spentUsdc.
   */
  static async recordFill(wallet: string, filledUsdc: number): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $inc: { tradesExecuted: 1, spentUsdc: filledUsdc } }
    );
  }

  /**
   * Record a SELL fill: recycle the proceeds back into available allocation.
   * Uses aggregation pipeline update to floor spentUsdc at 0.
   */
  static async recordSellFill(wallet: string, filledUsdc: number): Promise<void> {
    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      [{ $set: { spentUsdc: { $max: [0, { $subtract: ['$spentUsdc', filledUsdc] }] } } }]
    );
    console.log(`[TraderLoader] Recycled $${filledUsdc.toFixed(2)} back into allocation for ${wallet.slice(0, 10)}...`);
  }

  /**
   * Check if a trader still has allocation remaining (real-time DB check).
   * Used for a final guard before order submission to handle concurrent fills.
   */
  static async hasAllocation(wallet: string, needed: number): Promise<boolean> {
    const trader = (await CopyTrader.findOne(
      { wallet: wallet.toLowerCase() },
      { allocationUsdc: 1, spentUsdc: 1 }
    ).lean()) as unknown as { allocationUsdc: number; spentUsdc: number } | null;
    if (!trader) return false;
    return (trader.allocationUsdc - trader.spentUsdc) >= needed;
  }
}
