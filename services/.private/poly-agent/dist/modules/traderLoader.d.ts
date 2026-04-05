import { ICopyTrader } from '../db/models/CopyTrader';
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
export declare class TraderLoader {
    /**
     * Returns all active traders. Fresh DB read every call — callers should
     * cache the result for the duration of a single poll cycle if needed.
     */
    static getActive(): Promise<ICopyTrader[]>;
    static get(wallet: string): Promise<ICopyTrader | null>;
    /**
     * Advance the cursor so next poll only fetches new activities.
     * Only advances forward — never moves cursor backwards.
     */
    static updateLastSeen(wallet: string, ts: number): Promise<void>;
    static updateLastPolled(wallet: string): Promise<void>;
    /**
     * Increment skip counters. Called after every skipped trade.
     */
    static recordSkip(wallet: string, reason: string): Promise<void>;
    /**
     * Increment detected counter only (before bet sizing decision).
     * Called once per detected TRADE activity.
     */
    static recordDetected(wallet: string): Promise<void>;
    /**
     * Increment above-avg counter (trade passed the avgBet filter).
     */
    static recordAboveAvg(wallet: string): Promise<void>;
    /**
     * Record a successful fill: increment executed counter and add to spentUsdc.
     */
    static recordFill(wallet: string, filledUsdc: number): Promise<void>;
    /**
     * Record a SELL fill: recycle the proceeds back into available allocation.
     * Uses aggregation pipeline update to floor spentUsdc at 0.
     */
    static recordSellFill(wallet: string, filledUsdc: number): Promise<void>;
    /**
     * Check if a trader still has allocation remaining (real-time DB check).
     * Used for a final guard before order submission to handle concurrent fills.
     */
    static hasAllocation(wallet: string, needed: number): Promise<boolean>;
}
