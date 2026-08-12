import type { EdgeChainId } from './chains';
import { fetchWalletSwapLegs, type ExcludedTradeReason } from './fetchTrades';
import { getTokenMetadata, getCurrentPriceUsd } from './priceService';
import type { ReconstructedPosition, TradeLeg } from './types';

const DUST_QTY_EPSILON = 1e-9;
const DUST_USD_THRESHOLD = 1; // positions worth less than $1 total are noise, not a real trade

/**
 * FIFO round-trip reconstruction, per token: a "position" spans from the
 * first buy after being flat to the point qty returns to zero (or stays
 * open). Every leg in between - however many buys/sells - stays attached
 * to that one position, because entry/exit/sizing analysis all need the
 * full leg sequence (tranches, add-ons, scale-ins), not just a netted
 * open/close pair.
 */
function reconstructPositionsForToken(
  chain: EdgeChainId,
  tokenAddress: string,
  tokenSymbol: string,
  poolAddress: string | null,
  legs: TradeLeg[]
): { positions: ReconstructedPosition[]; excluded: ExcludedTradeReason[] } {
  const positions: ReconstructedPosition[] = [];
  const excludedCounts = new Map<string, number>();
  const bump = (reason: string) => excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);

  let currentLegs: TradeLeg[] = [];
  let heldQty = 0;

  const closeOut = (isOpen: boolean) => {
    if (currentLegs.length === 0) return;
    positions.push(buildPosition(chain, tokenAddress, tokenSymbol, poolAddress, currentLegs, isOpen));
    currentLegs = [];
  };

  for (const leg of legs) {
    if (leg.side === 'buy') {
      if (heldQty <= DUST_QTY_EPSILON) closeOut(false);
      currentLegs.push(leg);
      heldQty += leg.qty;
      continue;
    }

    if (currentLegs.length === 0 || heldQty <= DUST_QTY_EPSILON) {
      bump('sell with no matching buy (airdrop or transfer-in) - excluded from entry/exit analysis');
      continue;
    }

    if (leg.qty > heldQty * 1.0001) {
      bump('sold more than tracked buy quantity (partial airdrop/transfer-in) - size clipped to tracked amount');
    }
    const sellQty = Math.min(leg.qty, heldQty);
    currentLegs.push({ ...leg, qty: sellQty, usd: sellQty * leg.priceUsd });
    heldQty -= sellQty;
  }

  closeOut(heldQty > DUST_QTY_EPSILON);

  return { positions, excluded: Array.from(excludedCounts, ([reason, count]) => ({ reason, count })) };
}

function buildPosition(
  chain: EdgeChainId,
  tokenAddress: string,
  tokenSymbol: string,
  poolAddress: string | null,
  legs: TradeLeg[],
  isOpen: boolean
): ReconstructedPosition {
  const buys = legs.filter((l) => l.side === 'buy');
  const sells = legs.filter((l) => l.side === 'sell');

  const totalBuyUsd = buys.reduce((s, l) => s + l.usd, 0);
  const totalBuyQty = buys.reduce((s, l) => s + l.qty, 0);
  const totalSellUsd = sells.reduce((s, l) => s + l.usd, 0);
  const totalSellQty = sells.reduce((s, l) => s + l.qty, 0);

  const entryTs = buys[0]?.ts ?? legs[0].ts;
  const exitTs = !isOpen && sells.length > 0 ? sells[sells.length - 1].ts : null;

  return {
    chain,
    tokenAddress,
    tokenSymbol,
    poolAddress,
    legs,
    isOpen,
    isDust: totalBuyUsd < DUST_USD_THRESHOLD,
    entryTs,
    exitTs,
    avgEntryPriceUsd: totalBuyQty > 0 ? totalBuyUsd / totalBuyQty : 0,
    avgExitPriceUsd: totalSellQty > 0 ? totalSellUsd / totalSellQty : null,
    totalSizeUsd: totalBuyUsd,
    realizedPnlUsd: isOpen ? null : totalSellUsd - totalBuyUsd,
    holdSeconds: exitTs ? (exitTs.getTime() - entryTs.getTime()) / 1000 : null,
    peakPriceUsd: null, // filled by the exit engine (needs an OHLC lookup)
    peakPriceTs: null,
    ageAtEntrySeconds: null, // filled by the entry engine (needs launch-time lookup)
    liquidityUsdAtEntry: null,
    pricePercentileAtEntry: null,
    momentumAtEntryPct: null,
  };
}

export interface WalletPortfolio {
  chain: EdgeChainId;
  positions: ReconstructedPosition[];
  excludedTrades: ExcludedTradeReason[];
  currentHoldingsUsd: number;
}

/** Full pipeline for one chain: fetch legs -> classify per token -> FIFO reconstruct -> value open positions. */
export async function reconstructWalletPortfolio(chain: EdgeChainId, wallet: string): Promise<WalletPortfolio> {
  const { legsByToken, excluded: fetchExcluded } = await fetchWalletSwapLegs(chain, wallet);

  const positions: ReconstructedPosition[] = [];
  const excludedCounts = new Map<string, number>();
  for (const e of fetchExcluded) excludedCounts.set(e.reason, e.count);
  const bump = (reason: string, count: number) =>
    excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + count);

  let currentHoldingsUsd = 0;

  for (const [tokenAddress, legs] of legsByToken) {
    const meta = await getTokenMetadata(chain, tokenAddress);
    const { positions: tokenPositions, excluded } = reconstructPositionsForToken(
      chain,
      tokenAddress,
      meta?.symbol || tokenAddress.slice(0, 6),
      meta?.poolAddress ?? null,
      legs
    );
    for (const e of excluded) bump(e.reason, e.count);

    for (const pos of tokenPositions) {
      positions.push(pos);
      if (pos.isOpen && !pos.isDust) {
        const remainingQty =
          pos.legs.filter((l) => l.side === 'buy').reduce((s, l) => s + l.qty, 0) -
          pos.legs.filter((l) => l.side === 'sell').reduce((s, l) => s + l.qty, 0);
        const { priceUsd } = await getCurrentPriceUsd(chain, tokenAddress);
        if (priceUsd != null) currentHoldingsUsd += remainingQty * priceUsd;
      }
    }
  }

  const excludedTrades: ExcludedTradeReason[] = Array.from(excludedCounts, ([reason, count]) => ({
    reason,
    count,
  }));

  return { chain, positions, excludedTrades, currentHoldingsUsd };
}
