import mongoose, { Schema, Document } from 'mongoose';

// Status state machine:
// draft → pending_funding → executing → open → monitoring → closing → closed
//                                                                    → failed
//                                                                    → cancelled
export type TradeSetupStatus =
  | 'draft'
  | 'pending_funding'
  | 'executing'
  | 'open'
  | 'monitoring'
  | 'closing'
  | 'closed'
  | 'failed'
  | 'cancelled';

export interface ITradeSetup extends Document {
  // Ownership
  agentId: string;
  userId: string;           // ownerWallet

  // Strategy config (set at creation, immutable after executing)
  pair: string;             // e.g. "BTC/USD"
  direction: 'long' | 'short';
  collateral: number;       // USDC
  leverage: number;
  tpPct: number;            // take-profit % from entry
  slPct: number;            // stop-loss % from entry
  orderType: 'MARKET' | 'LIMIT' | 'STOP_LIMIT';
  openPrice?: number;       // for limit/stop-limit orders

  // Execution details (filled on execute-open success)
  txHash?: string;
  pairIndex?: number;
  tradeIndex?: number;
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  openingFeeUsdc?: number;
  lossProtectionPct?: number;
  agentWalletAddress?: string;
  executedAt?: Date;

  // Monitoring link
  monitoringTaskId?: string;    // MonitoringTask._id

  // Closure details (filled on execute-close success)
  closeTxHash?: string;
  exitPrice?: number;
  pnl?: number;
  closedAt?: Date;
  closeReason?: 'manual' | 'tp_hit' | 'sl_hit' | 'signal_exit' | 'agent_decision';

  // Error info
  failureReason?: string;

  status: TradeSetupStatus;
  createdAt: Date;
  updatedAt: Date;
}

const TradeSetupSchema = new Schema<ITradeSetup>({
  agentId:   { type: String, required: true },
  userId:    { type: String, required: true, lowercase: true },

  pair:      { type: String, required: true },
  direction: { type: String, enum: ['long', 'short'], required: true },
  collateral:{ type: Number, required: true },
  leverage:  { type: Number, required: true },
  tpPct:     { type: Number, required: true },
  slPct:     { type: Number, required: true },
  orderType: { type: String, enum: ['MARKET', 'LIMIT', 'STOP_LIMIT'], default: 'MARKET' },
  openPrice: { type: Number },

  txHash:             { type: String },
  pairIndex:          { type: Number },
  tradeIndex:         { type: Number },
  entryPrice:         { type: Number },
  tpPrice:            { type: Number },
  slPrice:            { type: Number },
  openingFeeUsdc:     { type: Number },
  lossProtectionPct:  { type: Number },
  agentWalletAddress: { type: String },
  executedAt:         { type: Date },

  monitoringTaskId: { type: String },

  closeTxHash:  { type: String },
  exitPrice:    { type: Number },
  pnl:          { type: Number },
  closedAt:     { type: Date },
  closeReason:  {
    type: String,
    enum: ['manual', 'tp_hit', 'sl_hit', 'signal_exit', 'agent_decision'],
  },

  failureReason: { type: String },

  status: {
    type: String,
    enum: ['draft', 'pending_funding', 'executing', 'open', 'monitoring', 'closing', 'closed', 'failed', 'cancelled'],
    default: 'draft',
  },
}, { timestamps: true, collection: 'trade_setups' });

TradeSetupSchema.index({ agentId: 1, status: 1 });
TradeSetupSchema.index({ userId: 1 });
TradeSetupSchema.index({ tradeIndex: 1, pairIndex: 1 });
TradeSetupSchema.index({ createdAt: -1 });

export default mongoose.models.TradeSetup ||
  mongoose.model<ITradeSetup>('TradeSetup', TradeSetupSchema);
