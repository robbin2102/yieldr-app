import { SkipReason } from '../db/models/CopyTrade';
import { ICopyTrader } from '../db/models/CopyTrader';

/**
 * BetSizer — portfolio-proportional copy sizing using a fixed daily copy ratio.
 *
 * copy_ratio is computed once at session start and refreshed at midnight by
 * RatioScheduler. It equals: allocationUsdc / traderOpenPositionsUsdc_at_snapshot
 *
 * This gives stable, consistent mirroring — every trade for a given trader is
 * sized at the same % of their bet, regardless of intra-day book changes.
 *
 *   scaled_bet = traderBetUsdc × trader.copyRatio
 *   capped at trader.maxBetUsdc
 *   capped at available allocation (allocationUsdc - spentUsdc)
 *
 * The scaled_bet is added to the position accumulator. Execution fires when
 * the accumulator for this (wallet, tokenId, side) crosses baseBetUsdc ($5).
 *
 * Examples (allocationUsdc=$50, openPositions=$800 → copyRatio=6.25%, baseBet=$5, maxBet=$20):
 *   trader bets $4    → scaled = $0.25  → accumulate
 *   trader bets $64   → scaled = $4.00  → accumulate
 *   trader bets $80   → scaled = $5.00  → execute immediately
 *   trader bets $300  → scaled = $18.75 → execute immediately
 *   trader bets $500  → scaled = $31.25 → capped at $20, execute
 *
 * NO_RATIO skip: copyRatio is null when trader has no open positions at snapshot
 * time. Trades are skipped until midnight recompute finds a real book size.
 */
export interface BetSizeResult {
  scaledBetUsdc: number;
  skip: boolean;
  skipReason?: SkipReason;
  skipDetail?: string;
}

export function calcCopyBet(
  traderBetUsdc: number,
  trader: Pick<ICopyTrader, 'baseBetUsdc' | 'maxBetUsdc' | 'allocationUsdc' | 'spentUsdc' | 'copyRatio'>
): BetSizeResult {
  const { baseBetUsdc, maxBetUsdc, allocationUsdc, spentUsdc, copyRatio } = trader;
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

  // 2. No ratio yet — trader had no open positions at last snapshot
  if (!copyRatio) {
    return {
      scaledBetUsdc: 0,
      skip: true,
      skipReason: 'NO_RATIO',
      skipDetail: 'copyRatio not yet computed (trader had no open positions at last snapshot; retries at midnight)',
    };
  }

  // 3. Portfolio-proportional scaling using fixed daily ratio
  const rawScaled = traderBetUsdc * copyRatio;
  const capped = Math.min(maxBetUsdc, rawScaled);

  // Allow small contributions down to $0.01 so they can accumulate toward $5 trigger
  const scaledBet = Math.max(0.01, capped);

  // 4. Clamp to remaining allocation
  const finalBet = Math.min(scaledBet, available);

  return { scaledBetUsdc: finalBet, skip: false };
}
