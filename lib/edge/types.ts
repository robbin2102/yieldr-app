/**
 * Shared types for the wallet edge-detection feature.
 * These are the in-memory / API-response shapes; models/*.ts wrap the
 * persisted subset of these into Mongoose schemas.
 */
import type { EdgeChainId } from './chains';

export type Verdict = 'strong_edge' | 'possible_edge' | 'no_edge' | 'negative_edge';
export type ConfidenceTier = 'insufficient' | 'provisional' | 'high';

/**
 * Subtle statistical backing for a metric/bucket. Always computed and
 * always stored, regardless of sample size - never gates whether a
 * finding is shown, only how it's annotated.
 */
export interface ConfidenceBlock {
  tier: ConfidenceTier;
  trades: number;
  winRateCiLow: number | null;
  winRateCiHigh: number | null;
  /** two-proportion z-test vs wallet baseline win rate; null if trades < 5 */
  pValueVsBaseline: number | null;
  /** does the direction of the finding hold in the most recent ~25% of trades? null if too few trades to split */
  recencyConsistent: boolean | null;
}

/** One leg (buy or sell) of a position, preserved individually - not netted - so
 * sizing/exit metrics that need per-leg detail (tranches, add-ons, scale-ins)
 * have what they need without re-fetching. */
export interface TradeLeg {
  side: 'buy' | 'sell';
  ts: Date;
  blockNumber: bigint;
  qty: number;
  priceUsd: number;
  usd: number;
  txHash: string;
}

/** A single token round-trip (or still-open position) reconstructed via FIFO. */
export interface ReconstructedPosition {
  chain: EdgeChainId;
  tokenAddress: string;
  tokenSymbol: string;
  poolAddress: string | null;
  legs: TradeLeg[];
  isOpen: boolean;
  isDust: boolean;
  entryTs: Date;
  exitTs: Date | null;
  avgEntryPriceUsd: number;
  avgExitPriceUsd: number | null;
  totalSizeUsd: number;
  realizedPnlUsd: number | null;
  holdSeconds: number | null;
  peakPriceUsd: number | null;
  peakPriceTs: Date | null;
  // entry context (filled by the entry engine)
  ageAtEntrySeconds: number | null;
  liquidityUsdAtEntry: number | null;
  pricePercentileAtEntry: number | null;
  momentumAtEntryPct: number | null;
}

export interface EntryConditionBucket {
  conditionLabel: string;
  trades: number;
  winRate: number;
  expectancyUsd: number;
  totalPnlUsd: number;
  confidence: ConfidenceBlock;
}

export type ExitStyleLabel = 'scaled_out' | 'sold_all_at_once' | 'held_into_loss_after_being_up';

export interface ExitConditionBucket {
  conditionLabel: ExitStyleLabel;
  trades: number;
  frequencyPct: number;
  peakCaptureAvg: number;
  expectancyUsd: number;
  confidence: ConfidenceBlock;
}

export interface EntryCategoryResult {
  verdict: Verdict;
  primaryDriver: string;
  transferable: boolean;
  expectancyUsd: number;
  conditionBreakdown: EntryConditionBucket[];
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

export interface ExitCategoryResult {
  verdict: Verdict;
  primaryDriver: string;
  transferable: boolean;
  expectancyUsd: number;
  peakCapturePct: number;
  roundTripRatePct: number;
  lossSideExitSpeedSeconds: number;
  winnerHoldTimeSeconds: number;
  conditionBreakdown: ExitConditionBucket[];
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

export interface SizingCategoryResult {
  verdict: Verdict;
  primaryDriver: string;
  transferable: boolean;
  expectancyUsd: number;
  avgSizeWinnersUsd: number;
  avgSizeLosersUsd: number;
  convictionRatio: number;
  sizeCoV: number;
  sizeSpectrumLabel: 'erratic' | 'mixed' | 'disciplined';
  winnerAddOnRatePct: number;
  lossSideSizeCutSpeedSeconds: number | null;
  addAfterLossRatioPct: number;
  scaleInShapeLabel: 'single_shot' | 'scaled_in' | 'mixed';
  negativeFindings: string[];
  confidence: ConfidenceBlock;
}

export interface EdgeReport {
  wallet: string;
  chains: EdgeChainId[];
  analysisWindow: { start: Date; end: Date; tradesAnalyzed: number };
  excludedTrades: { count: number; reason: string; sampleTxHashes: string[] }[];
  edgeScore: number;
  confidence: ConfidenceBlock;
  performance: {
    realizedPnlUsd: number;
    winRate: number;
    expectancyUsd: number;
    tradeCount: number;
    currentHoldingsUsd: number;
    roiPct: number;
  };
  categories: {
    entry: EntryCategoryResult;
    exit: ExitCategoryResult;
    sizing: SizingCategoryResult;
  };
  flags: { isTeamWallet: boolean; isBundlerLinked: boolean };
  computedAt: Date;
}
