import type { EdgeChainId } from './chains';
import { REFERENCE_TOKENS } from './referenceTokens';
import { getTokenMetadata, getOhlcWindow } from './priceService';
import { getPoolLiquidityUsdAtBlock } from './liquidity';
import type { ReconstructedPosition } from './types';

const MOMENTUM_WINDOW_MS = 30 * 60 * 1000;
const PRICE_PATH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Fills in the entry-context fields (age-since-launch, liquidity depth,
 * price percentile, pre-entry momentum) that reconstruct.ts leaves null,
 * since they all require external lookups (launch time, OHLC, a
 * point-in-time chain read) that reconstruction deliberately doesn't do.
 * Every field degrades to null on missing data rather than guessing -
 * the entry engine's dynamic bucket discovery treats null as
 * "this dimension doesn't apply to this trade", not zero.
 */
export async function enrichEntryContext(
  chain: EdgeChainId,
  position: ReconstructedPosition
): Promise<ReconstructedPosition> {
  if (!position.poolAddress || position.legs.length === 0) return position;

  const entryLeg = position.legs[0];
  const meta = await getTokenMetadata(chain, position.tokenAddress);
  const wethAddr = REFERENCE_TOKENS[chain].find((t) => t.symbol === 'WETH')?.address;

  const ageAtEntrySeconds =
    meta?.launchTimestamp && position.entryTs >= meta.launchTimestamp
      ? (position.entryTs.getTime() - meta.launchTimestamp.getTime()) / 1000
      : null;

  const liquidityUsdAtEntry = await getPoolLiquidityUsdAtBlock(
    chain,
    position.poolAddress,
    entryLeg.blockNumber,
    wethAddr,
    position.entryTs
  );

  const pathStart = new Date(
    Math.max(
      meta?.launchTimestamp?.getTime() ?? 0,
      position.entryTs.getTime() - PRICE_PATH_LOOKBACK_MS
    )
  );
  const { candles: pricePath } = await getOhlcWindow(chain, position.poolAddress, pathStart, position.entryTs);
  const pricePercentileAtEntry = percentileRank(pricePath.map((c) => c.close), entryLeg.priceUsd);

  const momentumStart = new Date(position.entryTs.getTime() - MOMENTUM_WINDOW_MS);
  const { candles: momentumPath } = await getOhlcWindow(chain, position.poolAddress, momentumStart, position.entryTs);
  const momentumAtEntryPct =
    momentumPath.length > 0 && momentumPath[0].open > 0
      ? ((entryLeg.priceUsd - momentumPath[0].open) / momentumPath[0].open) * 100
      : null;

  return {
    ...position,
    ageAtEntrySeconds,
    liquidityUsdAtEntry,
    pricePercentileAtEntry,
    momentumAtEntryPct,
  };
}

/** Fraction of `series` at or below `value` - null if the series is empty (no data, not "0th percentile"). */
function percentileRank(series: number[], value: number): number | null {
  if (series.length === 0) return null;
  const below = series.filter((v) => v <= value).length;
  return below / series.length;
}
