import mongoose, { Document, Schema } from 'mongoose';

export type TradeAction =
  | 'market_open'
  | 'limit_open'
  | 'market_close'
  | 'limit_cancel'
  | 'update_tp_sl'
  | 'update_margin';

export type TradeLogStatus = 'success' | 'failed';

export interface IAgentTrade extends Document {
  agentId: string;
  userId: string;

  // What was done
  action: TradeAction;

  // Position identifiers
  pair?: string;
  pairIndex?: number;
  tradeIndex?: number;
  orderIndex?: number;   // limit orders

  // Trade params (open)
  direction?: 'long' | 'short';
  collateral?: number;
  leverage?: number;
  tpPct?: number;
  slPct?: number;
  openPrice?: number;    // requested limit price

  // Filled from execution result
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  txHash?: string;
  feeUsdc?: number;

  // Close / margin update
  exitPrice?: number;
  pnl?: number;
  marginDelta?: number;  // positive = deposit, negative = withdraw

  // Outcome
  status: TradeLogStatus;
  error?: string;

  // Links
  tradeSetupId?: string;

  timestamp: Date;
}

const AgentTradeSchema = new Schema<IAgentTrade>(
  {
    agentId: { type: String, required: true, index: true },
    userId:  { type: String, required: true, lowercase: true, index: true },

    action:     { type: String, required: true },

    pair:       { type: String },
    pairIndex:  { type: Number },
    tradeIndex: { type: Number },
    orderIndex: { type: Number },

    direction:  { type: String },
    collateral: { type: Number },
    leverage:   { type: Number },
    tpPct:      { type: Number },
    slPct:      { type: Number },
    openPrice:  { type: Number },

    entryPrice: { type: Number },
    tpPrice:    { type: Number },
    slPrice:    { type: Number },
    txHash:     { type: String },
    feeUsdc:    { type: Number },

    exitPrice:   { type: Number },
    pnl:         { type: Number },
    marginDelta: { type: Number },

    status:       { type: String, required: true, default: 'success' },
    error:        { type: String },

    tradeSetupId: { type: String },

    timestamp: { type: Date, required: true, default: () => new Date() },
  },
  { collection: 'agent_trades' }
);

AgentTradeSchema.index({ agentId: 1, timestamp: -1 });
AgentTradeSchema.index({ tradeIndex: 1, pairIndex: 1 });

export default mongoose.models.AgentTrade ||
  mongoose.model<IAgentTrade>('AgentTrade', AgentTradeSchema);
