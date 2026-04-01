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

export function calcCopyBet(
  traderBetUsdc: number,
  trader: Pick<ICopyTrader, 'avgBet' | 'baseBetUsdc' | 'maxBetUsdc' | 'allocationUsdc' | 'spentUsdc'>
): BetSizeResult {
  const { avgBet, baseBetUsdc, maxBetUsdc, allocationUsdc, spentUsdc } = trader;
  const available = allocationUsdc - spentUsdc;

  // 1. Allocation exhausted
  if (available <= 0) {
    return {
      betUsdc: 0, skip: true,
      skipReason: 'ALLOCATION_FULL',
      skipDetail: `allocation exhausted ($${spentUsdc.toFixed(2)} / $${allocationUsdc})`,
    };
  }

  // 2. Below avg — probe/noise bet, skip
  if (traderBetUsdc < avgBet) {
    return {
      betUsdc: 0, skip: true,
      skipReason: 'BELOW_AVG',
      skipDetail: `$${traderBetUsdc.toFixed(0)} < avg $${avgBet.toFixed(0)}`,
    };
  }

  // 3. Conviction-proportional scaling
  const ratio  = traderBetUsdc / avgBet;
  const rawBet = baseBetUsdc * ratio;
  const bet    = Math.min(maxBetUsdc, Math.max(baseBetUsdc, rawBet));

  // 4. Clamp to remaining allocation
  return { betUsdc: Math.min(bet, available), skip: false };
}
