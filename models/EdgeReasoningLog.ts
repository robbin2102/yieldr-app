import mongoose, { Schema, Document } from 'mongoose';

export type EdgeReasoningVerdict = 'has_edge' | 'no_edge' | 'insufficient_data';

/**
 * One periodic "does this trader still have an edge" run from the reasoning
 * agent (lib/edge/reasoningAgent.ts) - fired by the cron in
 * app/api/edge/cron/reason every EDGE_REASONING_INTERVAL_HOURS per wallet.
 * Kept as its own append-only log (rather than folded into EdgeScore.history)
 * so the UI can render a running feed of agent commentary independent of
 * how often the underlying metrics get recomputed.
 */
export interface IEdgeReasoningLog extends Document {
  wallet: string;
  edgeScore: number;
  verdict: EdgeReasoningVerdict;
  /** Agent's plain-language explanation, capped at EDGE_REASONING_MAX_WORDS words. */
  reasoning: string;
  edgeDecayStatus: string;
  /** computedAt of the EdgeReport this reasoning run was based on. */
  reportComputedAt: Date;
  createdAt: Date;
}

const EdgeReasoningLogSchema = new Schema<IEdgeReasoningLog>(
  {
    wallet: { type: String, required: true, lowercase: true, index: true },
    edgeScore: { type: Number, required: true },
    verdict: { type: String, enum: ['has_edge', 'no_edge', 'insufficient_data'], required: true },
    reasoning: { type: String, required: true },
    edgeDecayStatus: { type: String, required: true },
    reportComputedAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'edge_reasoning_logs' }
);

EdgeReasoningLogSchema.index({ wallet: 1, createdAt: -1 });

export const EdgeReasoningLog =
  mongoose.models.EdgeReasoningLog ||
  mongoose.model<IEdgeReasoningLog>('EdgeReasoningLog', EdgeReasoningLogSchema);
