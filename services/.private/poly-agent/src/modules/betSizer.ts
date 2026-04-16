import { SkipReason } from '../db/models/CopyTrade';
import { ICopyTrader } from '../db/models/CopyTrader';

/**
 * BetSizer — conviction-multiplier sizing above avgBet.
 *
 * Logic:
 *   trader bet < avgBet  → BELOW_AVG skip (probe / noise bet)
 *   trader bet >= avgBet → copy_bet = baseBetUsdc × (traderBet / avgBet)
 *                          floored  at baseBetUsdc ($5)
 *                          capped   at 30% of allocationUsdc (scales with allocation changes)
 *                          capped   at available allocation
 *
 * Per-position cap is 30% of the trader's allocationUsdc (not a fixed absolute).
 * This ensures the cap scales automatically when allocation is increased/decreased.
 *
 * Examples (base=$5, alloc=$100 → positionCap=$30, avgBet=$100):
 *   trader bet = $50   → SKIP (below avg)
 *   trader bet = $100  → $5   (1× avg → base)
 *   trader bet = $200  → $10  (2× avg)
 *   trader bet = $300  → $15  (3× avg)
 *   trader bet = $600+ → $30  (capped at 30% of $100 alloc)
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

  // 1. Below avg — probe/noise bet, skip regardless of allocation state.
  // Checked first so tiny trades are classified correctly even when allocation
  // is also exhausted (analytics and grouped scanner rely on this distinction).
  if (traderBetUsdc < avgBet) {
    return {
      betUsdc: 0, skip: true,
      skipReason: 'BELOW_AVG',
      skipDetail: `$${traderBetUsdc.toFixed(0)} < avg $${avgBet.toFixed(0)}`,
    };
  }

  // 2. Allocation exhausted — conviction trade but no room left
  if (available <= 0) {
    return {
      betUsdc: 0, skip: true,
      skipReason: 'ALLOCATION_FULL',
      skipDetail: `allocation exhausted ($${spentUsdc.toFixed(2)} / $${allocationUsdc})`,
    };
  }

  // 3. Conviction-proportional scaling
  // Per-position cap = 30% of total allocation (scales when allocation is adjusted)
  const positionCap = allocationUsdc * 0.30;
  const ratio  = traderBetUsdc / avgBet;
  const rawBet = baseBetUsdc * ratio;
  const bet    = Math.min(positionCap, Math.max(baseBetUsdc, rawBet));

  // 4. Clamp to remaining allocation
  return { betUsdc: Math.min(bet, available), skip: false };
}
