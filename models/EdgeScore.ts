import mongoose, { Schema, Document } from 'mongoose';

const ConfidenceBlockSchema = new Schema(
  {
    tier: { type: String, enum: ['insufficient', 'provisional', 'high'], required: true },
    trades: { type: Number, required: true },
    winRateCiLow: { type: Number, default: null },
    winRateCiHigh: { type: Number, default: null },
    pValueVsBaseline: { type: Number, default: null },
    recencyConsistent: { type: Boolean, default: null },
  },
  { _id: false }
);

const LuckTestSchema = new Schema(
  {
    n: { type: Number, required: true },
    distinctTokenCount: { type: Number, required: true },
    expectancyAllUsd: { type: Number, required: true },
    expectancyExcludingBestUsd: { type: Number, required: true },
    bestTradePnlUsd: { type: Number, default: null },
    pctOfTotalPnlFromBestTrade: { type: Number, default: null },
    bootstrapPositiveExpectancyPct: { type: Number, required: true },
    robust: { type: Boolean, required: true },
  },
  { _id: false }
);

const EntryConditionBucketSchema = new Schema(
  {
    conditionLabel: { type: String, required: true },
    trades: { type: Number, required: true },
    winRate: { type: Number, required: true },
    expectancyUsd: { type: Number, required: true },
    totalPnlUsd: { type: Number, required: true },
    confidence: { type: ConfidenceBlockSchema, required: true },
    luckTest: { type: LuckTestSchema, required: true },
  },
  { _id: false }
);

const ExitConditionBucketSchema = new Schema(
  {
    conditionLabel: {
      type: String,
      enum: ['scaled_out', 'sold_all_at_once', 'held_into_loss_after_being_up'],
      required: true,
    },
    trades: { type: Number, required: true },
    frequencyPct: { type: Number, required: true },
    peakCaptureAvg: { type: Number, required: true },
    expectancyUsd: { type: Number, required: true },
    confidence: { type: ConfidenceBlockSchema, required: true },
    luckTest: { type: LuckTestSchema, required: true },
  },
  { _id: false }
);

const EntryCategorySchema = new Schema(
  {
    verdict: { type: String, enum: ['strong_edge', 'possible_edge', 'no_edge', 'negative_edge'], required: true },
    primaryDriver: { type: String, required: true },
    transferable: { type: Boolean, required: true },
    expectancyUsd: { type: Number, required: true },
    conditionBreakdown: { type: [EntryConditionBucketSchema], default: [] },
    negativeFindings: { type: [String], default: [] },
    confidence: { type: ConfidenceBlockSchema, required: true },
  },
  { _id: false }
);

const ExitCategorySchema = new Schema(
  {
    verdict: { type: String, enum: ['strong_edge', 'possible_edge', 'no_edge', 'negative_edge'], required: true },
    primaryDriver: { type: String, required: true },
    transferable: { type: Boolean, required: true },
    expectancyUsd: { type: Number, required: true },
    peakCapturePct: { type: Number, required: true },
    roundTripRatePct: { type: Number, required: true },
    lossSideExitSpeedSeconds: { type: Number, required: true },
    winnerHoldTimeSeconds: { type: Number, required: true },
    conditionBreakdown: { type: [ExitConditionBucketSchema], default: [] },
    negativeFindings: { type: [String], default: [] },
    confidence: { type: ConfidenceBlockSchema, required: true },
  },
  { _id: false }
);

const PostLossBehaviorSchema = new Schema(
  {
    bigLossEventCount: { type: Number, required: true },
    windowTradesAnalyzed: { type: Number, required: true },
    avgSizeRatioPostLoss: { type: Number, default: null },
    winRatePostLoss: { type: Number, default: null },
    winRateBaseline: { type: Number, required: true },
    label: { type: String, enum: ['revenge_sizing', 'disciplined_after_loss', 'no_signal'], required: true },
    confidenceTier: { type: String, enum: ['insufficient', 'provisional', 'high'], required: true },
  },
  { _id: false }
);

const SizingCategorySchema = new Schema(
  {
    verdict: { type: String, enum: ['strong_edge', 'possible_edge', 'no_edge', 'negative_edge'], required: true },
    primaryDriver: { type: String, required: true },
    transferable: { type: Boolean, required: true },
    expectancyUsd: { type: Number, required: true },
    avgSizeWinnersUsd: { type: Number, required: true },
    avgSizeLosersUsd: { type: Number, required: true },
    convictionRatio: { type: Number, required: true },
    sizeCoV: { type: Number, required: true },
    sizeSpectrumLabel: { type: String, enum: ['erratic', 'mixed', 'disciplined'], required: true },
    winnerAddOnRatePct: { type: Number, required: true },
    lossSideSizeCutSpeedSeconds: { type: Number, default: null },
    addAfterLossRatioPct: { type: Number, required: true },
    scaleInShapeLabel: { type: String, enum: ['single_shot', 'scaled_in', 'mixed'], required: true },
    postLossBehavior: { type: PostLossBehaviorSchema, required: true },
    negativeFindings: { type: [String], default: [] },
    confidence: { type: ConfidenceBlockSchema, required: true },
  },
  { _id: false }
);

const TopFindingSchema = new Schema(
  {
    category: { type: String, enum: ['entry', 'exit', 'sizing'], required: true },
    label: { type: String, required: true },
    impactUsd: { type: Number, required: true },
    detail: { type: String, required: true },
    confidenceTier: { type: String, enum: ['insufficient', 'provisional', 'high'], required: true },
    robust: { type: Boolean, required: true },
  },
  { _id: false }
);

const RiskAdjustedStatsSchema = new Schema(
  {
    n: { type: Number, required: true },
    meanReturnPct: { type: Number, required: true },
    medianReturnPct: { type: Number, required: true },
    stdDevReturnPct: { type: Number, required: true },
    downsideDeviationPct: { type: Number, required: true },
    sharpeRatio: { type: Number, default: null },
    sortinoRatio: { type: Number, default: null },
    bestTradeReturnPct: { type: Number, default: null },
    worstTradeReturnPct: { type: Number, default: null },
  },
  { _id: false }
);

const BettablePatternSchema = new Schema(
  {
    name: { type: String, enum: ['disciplined_scaler', 'loss_averse_exiter', 'repeat_conviction_trader'], required: true },
    label: { type: String, required: true },
    detected: { type: Boolean, required: true },
    evidence: { type: String, required: true },
    confidenceTier: { type: String, enum: ['insufficient', 'provisional', 'high'], required: true },
  },
  { _id: false }
);

const EdgeSnapshotPointSchema = new Schema(
  {
    computedAt: { type: Date, required: true },
    edgeScore: { type: Number, required: true },
    winRate: { type: Number, required: true },
    expectancyUsd: { type: Number, required: true },
  },
  { _id: false }
);

const EdgeDecaySchema = new Schema(
  {
    status: { type: String, enum: ['improving', 'stable', 'decaying', 'insufficient_history'], required: true },
    edgeScoreDelta: { type: Number, default: null },
    winRateDeltaPct: { type: Number, default: null },
    expectancyDeltaUsd: { type: Number, default: null },
    priorSnapshotCount: { type: Number, required: true },
    snapshots: { type: [EdgeSnapshotPointSchema], default: [] },
  },
  { _id: false }
);

const EdgeReportSchema = new Schema(
  {
    chains: { type: [String], required: true },
    analysisWindow: {
      start: { type: Date, required: true },
      end: { type: Date, required: true },
      tradesAnalyzed: { type: Number, required: true },
    },
    excludedTrades: {
      type: [{ count: Number, reason: String, sampleTxHashes: [String], _id: false }],
      default: [],
    },
    edgeScore: { type: Number, required: true },
    confidence: { type: ConfidenceBlockSchema, required: true },
    performance: {
      realizedPnlUsd: { type: Number, required: true },
      winRate: { type: Number, required: true },
      expectancyUsd: { type: Number, required: true },
      tradeCount: { type: Number, required: true },
      currentHoldingsUsd: { type: Number, required: true },
      roiPct: { type: Number, required: true },
    },
    categories: {
      entry: { type: EntryCategorySchema, required: true },
      exit: { type: ExitCategorySchema, required: true },
      sizing: { type: SizingCategorySchema, required: true },
    },
    topStrengths: { type: [TopFindingSchema], default: [] },
    topWeaknesses: { type: [TopFindingSchema], default: [] },
    edgeDecay: { type: EdgeDecaySchema, required: true },
    riskAdjusted: { type: RiskAdjustedStatsSchema, required: true },
    luckTest: { type: LuckTestSchema, required: true },
    bettablePatterns: { type: [BettablePatternSchema], default: [] },
    flags: {
      isTeamWallet: { type: Boolean, default: false },
      isBundlerLinked: { type: Boolean, default: false },
    },
    computedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

export interface IEdgeScore extends Document {
  wallet: string;
  history: (typeof EdgeReportSchema)[];
  latestComputedAt: Date;
  /** Gate for the periodic reasoning cron (app/api/edge/cron/reason) - null until the first reasoning run. */
  lastReasoningAt: Date | null;
}

const EdgeScoreSchema = new Schema<IEdgeScore>(
  {
    wallet: { type: String, required: true, lowercase: true, index: true },
    history: { type: [EdgeReportSchema], default: [] },
    latestComputedAt: { type: Date, default: Date.now },
    lastReasoningAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'edge_scores',
  }
);

EdgeScoreSchema.index({ wallet: 1, latestComputedAt: -1 });

export const EdgeScore =
  mongoose.models.EdgeScore || mongoose.model<IEdgeScore>('EdgeScore', EdgeScoreSchema);
