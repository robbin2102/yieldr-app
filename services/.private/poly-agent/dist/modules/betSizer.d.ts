import { SkipReason } from '../db/models/CopyTrade';
import { ICopyTrader } from '../db/models/CopyTrader';
/**
 * BetSizer — conviction-multiplier sizing above avgBet.
 *
 * Logic:
 *   trader bet < avgBet  → BELOW_AVG skip (probe / noise bet)
 *   trader bet >= avgBet → copy_bet = baseBetUsdc × (traderBet / avgBet)
 *                          floored  at baseBetUsdc ($5)
 *                          capped   at maxBetUsdc  ($20)
 *                          capped   at available allocation
 *
 * Examples (base=$5, max=$20, avgBet=$100):
 *   trader bet = $50   → SKIP (below avg)
 *   trader bet = $100  → $5   (1× avg → base)
 *   trader bet = $200  → $10  (2× avg)
 *   trader bet = $300  → $15  (3× avg)
 *   trader bet = $400+ → $20  (capped)
 */
export interface BetSizeResult {
    betUsdc: number;
    skip: boolean;
    skipReason?: SkipReason;
    skipDetail?: string;
}
export declare function calcCopyBet(traderBetUsdc: number, trader: Pick<ICopyTrader, 'avgBet' | 'baseBetUsdc' | 'maxBetUsdc' | 'allocationUsdc' | 'spentUsdc'>): BetSizeResult;
