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

const EntryConditionBucketSchema = new Schema(
  {
    conditionLabel: { type: String, required: true },
    trades: { type: Number, required: true },
    winRate: { type: Number, required: true },
    expectancyUsd: { type: Number, required: true },
    totalPnlUsd: { type: Number, required: true },
    confidence: { type: ConfidenceBlockSchema, required: true },
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
    negativeFindings: { type: [String], default: [] },
    confidence: { type: ConfidenceBlockSchema, required: true },
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
}

const EdgeScoreSchema = new Schema<IEdgeScore>(
  {
    wallet: { type: String, required: true, lowercase: true, index: true },
    history: { type: [EdgeReportSchema], default: [] },
    latestComputedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    collection: 'edge_scores',
  }
);

EdgeScoreSchema.index({ wallet: 1, latestComputedAt: -1 });

export const EdgeScore =
  mongoose.models.EdgeScore || mongoose.model<IEdgeScore>('EdgeScore', EdgeScoreSchema);
