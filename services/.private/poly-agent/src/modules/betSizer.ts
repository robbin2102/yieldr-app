import { SkipReason } from '../db/models/CopyTrade';
import { ICopyTrader } from '../db/models/CopyTrader';

/**
 * BetSizer — portfolio-proportional copy sizing.
 *
 * Formula:
 *   copy_ratio  = allocationUsdc / traderOpenPositionsUsdc
 *   scaled_bet  = traderBetUsdc × copy_ratio
 *
 * The scaled_bet is added to the position accumulator. Execution fires when
 * the accumulator for this (wallet, tokenId, side) crosses baseBetUsdc ($5).
 * This naturally handles traders who split large orders into many small chunks.
 *
 * Hard cap: min(scaled_bet, available_alloc) — never overspend.
 *
 * Fallback when traderOpenPositionsUsdc = 0 (trader has no open positions yet):
 *   Use allocationUsdc as the denominator (copy_ratio = 1.0, effectively max size).
 *   This handles a fresh trader who just started opening positions.
 *
 * Examples (allocationUsdc=$50, traderOpenPositionsUsdc=$800, baseBet=$5, maxBet=$20):
 *   copy_ratio = 50/800 = 6.25%
 *   trader bets $4   → scaled = $0.25  → accumulate
 *   trader bets $64  → scaled = $4.00  → accumulate
 *   trader bets $100 → scaled = $6.25  → execute immediately
 *   trader bets $500 → scaled = $31.25 → capped at $20 max, execute
 */
export interface BetSizeResult {
  scaledBetUsdc: number;   // portfolio-proportional amount to add to accumulator
  skip: boolean;
  skipReason?: SkipReason;
  skipDetail?: string;
}

export function calcCopyBet(
  traderBetUsdc: number,
  trader: Pick<ICopyTrader, 'baseBetUsdc' | 'maxBetUsdc' | 'allocationUsdc' | 'spentUsdc'>,
  traderOpenPositionsUsdc: number
): BetSizeResult {
  const { baseBetUsdc, maxBetUsdc, allocationUsdc, spentUsdc } = trader;
  const available = allocationUsdc - spentUsdc;

  // 1. Allocation exhausted
  if (available <= 0) {
    return {
      scaledBetUsdc: 0,
      skip: true,
      skipReason: 'ALLOCATION_FULL',
      skipDetail: `allocation exhausted ($${spentUsdc.toFixed(2)} / $${allocationUsdc})`,
    };
  }

  // 2. Portfolio-proportional scaling
  // Denominator: trader's total open position value.
  // Fallback to allocationUsdc when trader has no open positions (new position entry).
  const denominator = traderOpenPositionsUsdc > 0 ? traderOpenPositionsUsdc : allocationUsdc;
  const copyRatio = allocationUsdc / denominator;
  const rawScaled = traderBetUsdc * copyRatio;

  // Cap at maxBetUsdc — never put more than this on a single accumulator trigger
  const capped = Math.min(maxBetUsdc, rawScaled);

  // Floor at a small fraction of baseBetUsdc — allow tiny accumulations to add up
  // (even $0.01 contributions accumulate toward the $5 trigger)
  const scaledBet = Math.max(0.01, capped);

  // 3. Clamp to remaining allocation
  const finalBet = Math.min(scaledBet, available);

  return { scaledBetUsdc: finalBet, skip: false };
}
