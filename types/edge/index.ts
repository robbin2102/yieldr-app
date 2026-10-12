export type Classification =
  | "analyzed_fomo_wallet"
  | "known_fomo_analysis_pending"
  | "insufficient_behavior_sample"
  | "blocked_price_coverage"
  | "blocked_price_and_sample_size"
  | "non_fomo_or_unindexed";
export type FindingStatus =
  | "validated_positive_edge"
  | "validated_risk_pattern"
  | "candidate_under_review"
  | "observed_behavior"
  | "observed_risk"
  | "insufficient_evidence"
  | "rejected_hypothesis";
export type Json =
  null | string | number | boolean | Json[] | { [key: string]: Json };
export interface Identity {
  id: string;
  name: string;
  evmWallet: string | null;
  solanaWallet: string | null;
}
export interface Finding {
  id: string;
  name: string;
  description: string;
  status: FindingStatus;
  n: number | null;
  positions: number | null;
  tokens: number | null;
  winRate: string | null;
  averageReturn: string | null;
  medianReturn: string | null;
  pnl: string | null;
  health: string;
  failedChecks: string[];
  evidence: Json;
}
export interface Position {
  episodeId: string;
  chain: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  openedAt: string | null;
  closedAt: string;
  realizedPnlUsd: string | null;
  verifiedAcquisitionCostUsd: string | null;
  returnPct: string | null;
  pricingStatus: "priced" | "partial" | "unavailable";
  includedInDollarTotals: boolean;
  buyCount: number;
  sellCount: number;
}
export interface Holding {
  name?:string|null; imageUrl?:string|null; priceObservedAt?:string|null; marketDataStatus?:string; assetType?:string;
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  quantity: string | null;
  price: string | null;
  value: string | null;
  costBasis: string | null;
  costBasisStatus: string;
  openEpisodeIds: string[];
  externalReceipt: boolean | null;
}
export interface Holdings {
  reconciliation?:{episodeId:string;chain:string;tokenAddress:string;status:string;quantity:string;note:string|null}[];
  observedAt: string | null;
  source: string | null;
  stale: boolean;
  status: "available" | "unavailable";
  items: Holding[];
}
export interface Story {
  tokenAddress?:string; currentBalanceStatus?:string;
  id: string;
  episodeId: string;
  symbol: string;
  chain: string;
  state: string;
  narrative: string;
  chapters: {
    id: string;
    at: string | null;
    action: string;
    description: string;
    outcome: string | null;
    pattern: string | null;
    status: string | null;
    priorEvidence: Json;
    correction: Json;
  }[];
}
export interface EdgeResult {
  sourceHashes?: Record<string, string>;
  pnlReporting?: Json;
  identity: Identity;
  summaryId: string;
  modelVersion: string;
  ruleVersion: string;
  analysisVersion: string | null;
  analyzedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  windowDays: number;
  classification: Classification;
  readiness: { status: string; failedChecks: string[]; evidence: Json };
  economicActions: number | null;
  closedPositions: number | null;
  openPositions: number | null;
  findings: Finding[];
  performance: {
    realizedPnl: string | null;
    unrealizedPnl: string | null;
    totalPnl: string | null;
    capitalAtStart: string | null;
    openCostBasis: string | null;
    winRate: string | null;
    averageReturn: string | null;
    medianReturn: string | null;
    averageWinner: string | null;
    averageLoser: string | null;
    payoffRatio: string | null;
    profitFactor: string | null;
    provenance: string;
  };
  exclusions: {
    unattributedDisposals: number | null;
    partiallyAttributedDisposals: number | null;
    excludedProceeds: string | null;
  };
}
export interface Scan {
  preview?: {activity?:{id:string;at:string}[];liveProgress?:{phase:string;current:number;total:number|null;unit:string;providerCalls?:number;providerErrors?:Record<string,number>;accessBlocked?:boolean};positions?:Position[];holdings?:Holdings;findings?:Finding[];actionsProcessed?:number}|null;
  scanId: string;
  wallet: string;
  classification: Classification;
  status: "queued" | "running" | "completed" | "blocked" | "failed";
  inputWallet?: string; walletType?: string; linkedWallets?: {evm:string|null;solana:string|null};
  identityName?: string|null; chains?: string[]; windowStart?: string; windowEnd?: string; forceFresh?: boolean;
  totalStages?: number; activeStage?: string|null; counts?: Record<string,number>; coverageDisclosure?: string;
  modelVersion?: string|null; ruleVersion?: string|null; failureCode?: string|null;
  cached: boolean;
  analysisTimestamp: string | null;
  summaryId: string | null;
  stages: { key: string; label: string; completedAt: string }[];
  createdAt: string;
  message: string | null;
}
export interface TopTrader {
  identity: Identity;
  summaryId: string;
  validatedCount: number;
  modelVersion: string;
  ruleVersion: string;
  analyzedAt: string | null;
}
