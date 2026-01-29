import mongoose, { Schema, Document } from 'mongoose';

export interface IAgentPosition {
  protocol: 'avantis' | 'hyperliquid' | 'polymarket';
  asset: string;
  direction: 'LONG' | 'SHORT' | 'YES' | 'NO';
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  leverage?: number;
}

export interface IFollowedTrader {
  wallet: string;
  platform: 'avantis' | 'hyperliquid' | 'polymarket';
  username?: string;
  pnl30d?: number;
  winRate?: number;
  roi30d?: number;
  totalPositions?: number;
  totalAUM?: number;
  followedAt: Date;
}

export interface IAgent extends Document {
  name: string;
  ownerWallet: string;
  markets: ('perps' | 'predictions' | 'liquidity')[];
  goals?: ('invest' | 'improve' | 'fund')[];
  status: 'creating' | 'active' | 'paused';

  // Positions scanned at creation
  positions: {
    avantis: IAgentPosition[];
    hyperliquid: IAgentPosition[];
    polymarket: IAgentPosition[];
  };

  // Portfolio summary
  portfolioSummary: {
    totalValue: number;
    totalPnl: number;
    positionCount: number;
  };

  // Traders being followed
  followedTraders: IFollowedTrader[];

  // PnL history for context
  pnlHistory: {
    hyperliquid30d?: number;
    polymarketRealized30d?: number;
    polymarketUnrealized?: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

const AgentPositionSchema = new Schema({
  protocol: {
    type: String,
    enum: ['avantis', 'hyperliquid', 'polymarket'],
    required: true,
  },
  asset: { type: String, required: true },
  direction: {
    type: String,
    enum: ['LONG', 'SHORT', 'YES', 'NO'],
    required: true,
  },
  size: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  currentPrice: { type: Number, required: true },
  pnl: { type: Number, required: true },
  leverage: { type: Number },
}, { _id: false });

const FollowedTraderSchema = new Schema({
  wallet: { type: String, required: true, lowercase: true },
  platform: {
    type: String,
    enum: ['avantis', 'hyperliquid', 'polymarket'],
    required: true,
  },
  username: { type: String },
  pnl30d: { type: Number },
  winRate: { type: Number },
  roi30d: { type: Number },
  totalPositions: { type: Number },
  totalAUM: { type: Number },
  followedAt: { type: Date, default: Date.now },
}, { _id: false });

const AgentSchema = new Schema<IAgent>({
  name: {
    type: String,
    required: true,
    maxlength: 30,
    trim: true,
  },
  ownerWallet: {
    type: String,
    required: true,
    lowercase: true,
  },
  markets: [{
    type: String,
    enum: ['perps', 'predictions', 'liquidity'],
  }],
  goals: [{
    type: String,
    enum: ['invest', 'improve', 'fund'],
  }],
  status: {
    type: String,
    enum: ['creating', 'active', 'paused'],
    default: 'creating',
  },
  positions: {
    avantis: [AgentPositionSchema],
    hyperliquid: [AgentPositionSchema],
    polymarket: [AgentPositionSchema],
  },
  portfolioSummary: {
    totalValue: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    positionCount: { type: Number, default: 0 },
  },
  followedTraders: [FollowedTraderSchema],
  pnlHistory: {
    hyperliquid30d: { type: Number },
    polymarketRealized30d: { type: Number },
    polymarketUnrealized: { type: Number },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes
AgentSchema.index({ ownerWallet: 1 });
AgentSchema.index({ status: 1 });
AgentSchema.index({ createdAt: -1 });

// Update timestamp on save
AgentSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export default mongoose.models.Agent ||
  mongoose.model<IAgent>('Agent', AgentSchema);
