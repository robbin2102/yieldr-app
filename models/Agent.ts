import mongoose, { Schema, Document } from 'mongoose';

export interface IFollowedTrader {
  wallet: string;
  platform: 'avantis' | 'hyperliquid' | 'polymarket';
  username?: string;
  pnl30d?: number;
  winRate?: number;
  roi30d?: number;
  totalPositions?: number;
  totalAUM?: number;
  matchReason?: string;
  followedAt: Date;
}

export interface IAgent extends Document {
  name: string;
  ownerWallet: string;
  markets: ('perps' | 'predictions' | 'liquidity')[];
  goals?: ('invest' | 'improve' | 'fund')[];
  status: 'creating' | 'active' | 'paused';

  // Portfolio summary (positions live in positions collection)
  portfolioSummary: {
    totalValue: number;
    totalPnl: number;
    positionCount: number;
  };

  // Traders being followed
  followedTraders: IFollowedTrader[];

  createdAt: Date;
  updatedAt: Date;
}

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
  matchReason: { type: String },
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
  portfolioSummary: {
    totalValue: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },
    positionCount: { type: Number, default: 0 },
  },
  followedTraders: [FollowedTraderSchema],
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
