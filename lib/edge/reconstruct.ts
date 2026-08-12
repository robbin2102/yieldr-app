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
  const excludedSamples = new Map<string, string[]>();
  const bump = (reason: string, hash: string) => {
    excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);
    const samples = excludedSamples.get(reason) ?? [];
    if (samples.length < 5) samples.push(hash);
    excludedSamples.set(reason, samples);
  };

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
      bump('sell with no matching buy (airdrop or transfer-in) - excluded from entry/exit analysis', leg.txHash);
      continue;
    }

    if (leg.qty > heldQty * 1.0001) {
      bump('sold more than tracked buy quantity (partial airdrop/transfer-in) - size clipped to tracked amount', leg.txHash);
    }
    const sellQty = Math.min(leg.qty, heldQty);
    currentLegs.push({ ...leg, qty: sellQty, usd: sellQty * leg.priceUsd });
    heldQty -= sellQty;
  }

  closeOut(heldQty > DUST_QTY_EPSILON);

  return {
    positions,
    excluded: Array.from(excludedCounts, ([reason, count]) => ({
      reason,
      count,
      sampleTxHashes: excludedSamples.get(reason) ?? [],
    })),
  };
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

export interface TokenTraded {
  chain: EdgeChainId;
  address: string;
  symbol: string;
  legCount: number;
}

export interface WalletPortfolio {
  chain: EdgeChainId;
  positions: ReconstructedPosition[];
  excludedTrades: ExcludedTradeReason[];
  currentHoldingsUsd: number;
  /** Every token that produced at least one priced leg - the answer to "which tokens were traded". */
  tokensTraded: TokenTraded[];
}

/** Full pipeline for one chain: fetch legs -> classify per token -> FIFO reconstruct -> value open positions. */
export async function reconstructWalletPortfolio(chain: EdgeChainId, wallet: string): Promise<WalletPortfolio> {
  const { legsByToken, excluded: fetchExcluded } = await fetchWalletSwapLegs(chain, wallet);
  console.log(`[edge:reconstruct] ${chain} received ${legsByToken.size} priced token(s) from fetchTrades`);

  const positions: ReconstructedPosition[] = [];
  const excludedCounts = new Map<string, number>();
  const excludedSamples = new Map<string, string[]>();
  for (const e of fetchExcluded) {
    excludedCounts.set(e.reason, e.count);
    excludedSamples.set(e.reason, e.sampleTxHashes);
  }
  const bump = (reason: string, count: number, hashes: string[]) => {
    excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + count);
    const samples = excludedSamples.get(reason) ?? [];
    excludedSamples.set(reason, [...samples, ...hashes].slice(0, 5));
  };

  let currentHoldingsUsd = 0;
  const tokensTraded: TokenTraded[] = [];

  for (const [tokenAddress, legs] of legsByToken) {
    const meta = await getTokenMetadata(chain, tokenAddress);
    const symbol = meta?.symbol || tokenAddress.slice(0, 6);
    tokensTraded.push({ chain, address: tokenAddress, symbol, legCount: legs.length });

    const { positions: tokenPositions, excluded } = reconstructPositionsForToken(
      chain,
      tokenAddress,
      symbol,
      meta?.poolAddress ?? null,
      legs
    );
    const closedCount = tokenPositions.filter((p) => !p.isOpen && !p.isDust).length;
    console.log(
      `[edge:reconstruct] ${chain} ${symbol} (${tokenAddress.slice(0, 8)}): ${legs.length} leg(s) -> ${
        tokenPositions.length
      } position(s) (${closedCount} closed, non-dust)${
        excluded.length ? `, excluded: ${excluded.map((e) => `${e.count}x ${e.reason}`).join('; ')}` : ''
      }`
    );
    for (const e of excluded) bump(e.reason, e.count, e.sampleTxHashes);

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
    sampleTxHashes: excludedSamples.get(reason) ?? [],
  }));

  console.log(
    `[edge:reconstruct] ${chain} totals: ${positions.length} position(s) (${
      positions.filter((p) => !p.isOpen && !p.isDust).length
    } closed non-dust), currentHoldingsUsd=${currentHoldingsUsd.toFixed(2)}`
  );

  return { chain, positions, excludedTrades, currentHoldingsUsd, tokensTraded };
}
