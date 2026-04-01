import { SkipReason } from '../db/models/CopyTrade';
import { ICopyTrader } from '../db/models/CopyTrader';

/**
 * BetSizer — proportional scaling above avgBet
 *
 * Logic:
 *   trader bet < avgBet         → SKIP (probe / noise bet)
 *   trader bet >= avgBet        → copy_bet = baseBetUsdc × (traderBet / avgBet)
 *                                 capped at maxBetUsdc
 *                                 floored at baseBetUsdc ($5)
 *
 * Examples with base=$5, max=$20:
 *   trader bet = avgBet (1×)    → $5
 *   trader bet = 2× avgBet      → $10
 *   trader bet = 3× avgBet      → $15
 *   trader bet = 4× avgBet      → $20 (capped)
 *   trader bet = 10× avgBet     → $20 (capped)
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
  const remaining = allocationUsdc - spentUsdc;

  // 1. Allocation exhausted
  if (remaining <= 0) {
    return {
      betUsdc: 0,
      skip: true,
      skipReason: 'ALLOCATION_FULL',
      skipDetail: `allocation exhausted ($${spentUsdc.toFixed(2)} / $${allocationUsdc})`,
    };
  }

  // 2. Below avg — probe bet, skip
  if (traderBetUsdc < avgBet) {
    return {
      betUsdc: 0,
      skip: true,
      skipReason: 'BELOW_AVG',
      skipDetail: `$${traderBetUsdc.toFixed(0)} < avg $${avgBet.toFixed(0)}`,
    };
  }

  // 3. Proportional scaling
  const ratio   = traderBetUsdc / avgBet;
  const rawBet  = baseBetUsdc * ratio;
  const cappedBet = Math.min(maxBetUsdc, rawBet);
  const bet = Math.max(baseBetUsdc, cappedBet);

  // 4. Can't afford even base bet
  if (remaining < baseBetUsdc) {
    return {
      betUsdc: 0,
      skip: true,
      skipReason: 'ALLOCATION_FULL',
      skipDetail: `only $${remaining.toFixed(2)} left, need $${baseBetUsdc} minimum`,
    };
  }

  // 5. Clamp to remaining allocation
  const finalBet = Math.min(bet, remaining);

  return { betUsdc: finalBet, skip: false };
}
