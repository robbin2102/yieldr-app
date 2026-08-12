import type { EdgeChainId } from './chains';
import { getOhlcWindow, peakPriceInWindow } from './priceService';
import type { ReconstructedPosition } from './types';

/**
 * Fills peakPriceUsd/peakPriceTs for a closed position - the exit engine's
 * peak-capture % needs the token's real high-water-mark between entry and
 * exit, not just the wallet's own trade prices. Falls back to the highest
 * price observed across the wallet's own sell legs when no OHLC feed
 * covers the chain (HOOD today) - a weaker proxy, tagged as such.
 */
export async function enrichExitContext(
  chain: EdgeChainId,
  position: ReconstructedPosition
): Promise<ReconstructedPosition> {
  if (!position.poolAddress || !position.exitTs) return position;

  const sellPrices = position.legs.filter((l) => l.side === 'sell').map((l) => l.priceUsd);
  const proxyFallback = sellPrices.length > 0 ? Math.max(...sellPrices, position.avgEntryPriceUsd) : position.avgEntryPriceUsd;

  const { candles } = await getOhlcWindow(chain, position.poolAddress, position.entryTs, position.exitTs);
  const peakPriceUsd = peakPriceInWindow(candles, proxyFallback);
  const peakCandle = candles.find((c) => c.high === peakPriceUsd);

  return {
    ...position,
    peakPriceUsd,
    peakPriceTs: peakCandle?.ts ?? position.exitTs,
  };
}
