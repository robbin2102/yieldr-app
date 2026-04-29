/**
 * v2 type definitions — shared across all v2 modules.
 *
 * DetectedTrade comes from OnChainDetector (on-chain WS).
 * Everything else is v2-only and not shared with the legacy system.
 */

// Re-export so v2 modules import from one place
export type { DetectedTrade } from '../modules/onChainDetector';

// ── Market metadata ──────────────────────────────────────────────────────────

export interface MarketMeta {
  conditionId: string;
  title:       string;
  outcome:     string;
  negRisk:     boolean;
  feeRateBps:  number;
}

// ── Execution strategy ───────────────────────────────────────────────────────

/**
 * 'auto'   — market orders for NEG_RISK, GTD for CTF (default)
 * 'market' — market (FAK) orders for all markets
 * 'gtd'    — GTD maker orders for all markets
 */
export type ExecutionStrategy = 'auto' | 'market' | 'gtd';

// ── Trade routing ────────────────────────────────────────────────────────────

export interface RoutedTrade {
  // From OnChainDetector
  txHash:           string;
  wallet:           string;   // source trader wallet
  label:            string;
  side:             'BUY' | 'SELL';
  usdcAmount:       number;   // trader's USDC size
  tokenAmount:      number;   // trader's token size
  impliedPrice:     number;   // trader's execution price
  tokenId:          string;
  exchange:         'CTF' | 'NEG_RISK' | 'CTF_V2' | 'NEG_RISK_V2';
  blockTimestampMs: number;
  receivedAtMs:     number;
  lagMs:            number;

  // Resolved by MarketMetaResolver
  meta: MarketMeta;

  // Resolved by ExecutionRouter
  strategy: 'market' | 'gtd';  // resolved (never 'auto')

  // Set by BetSizer
  copyBetUsdc:   number;
  copyShares?:   number;   // SELL only (proportional exit)

  // Set by orchestrator after recorder.createDetected() — passed to GTD executor for retry tracking
  tradeDocId?:   string;
}

// ── Order result ─────────────────────────────────────────────────────────────

export interface OrderAttempt {
  attemptNumber:  number;
  orderId:        string;
  transactionId?: string;  // CLOBv2 transactionID (replaces txHash in submit response)
  limitPrice:     number;
  requestedUsdc:  number;
  requestedShares: number;
  filledShares:   number;
  filledUsdc:     number;
  avgFillPrice:   number;
  submittedAtMs:  number;
  confirmedAtMs?: number;
}

export interface ExecutionResult {
  success:       boolean;
  totalFilled:   number;   // shares
  totalUsdc:     number;
  avgPrice:      number;
  attempts:      OrderAttempt[];
  failReason?:   string;
  durationMs:    number;
}

// ── Safety check results ──────────────────────────────────────────────────────

export interface SafetyResult {
  pass:   boolean;
  reason?: string;   // human-readable if failed
}

// ── Orderbook ────────────────────────────────────────────────────────────────

export interface BookLevel {
  price: number;
  size:  number;
}

export interface OrderBook {
  bestBid:   number;
  bestAsk:   number;
  bids:      BookLevel[];
  asks:      BookLevel[];
  fetchedAt: number;
}

// ── Pending order (GTD fill tracking) ────────────────────────────────────────

export interface PendingOrderV2 {
  orderId:        string;
  transactionId?: string;
  tradeDocId:     string;
  traderWallet:   string;
  side:           'BUY' | 'SELL';
  tokenId:        string;
  conditionId:    string;
  exchange:       'CTF' | 'NEG_RISK' | 'CTF_V2' | 'NEG_RISK_V2';
  limitPrice:     number;
  targetUsdc:     number;
  targetShares?:  number;
  submittedAtMs:  number;
  attempt:        number;
  impliedPrice:   number;   // trader's price at detection time
  filledShares:   number;
  filledUsdc:     number;
}
