import mongoose, { Schema, Document } from 'mongoose';

export interface ITraderProfile extends Document {
  // Identity
  wallet: string;
  profiledAt: Date;
  periodDays: number;

  // Basic stats
  totalActivities: number;
  buyCount: number;
  sellCount: number;
  redeemCount: number;
  otherCount: number;

  // Classification
  tradesPerDay: number;
  volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  buyRatio: number;
  strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';

  // Performance (from closed positions)
  closedPositionsCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netPnl: number;
  profitFactor: number;

  // Open positions
  openPositionsCount: number;
  openValue: number;
  unrealizedPnl: number;

  // Trade sizing
  avgTradeSize: number;
  medianTradeSize: number;
  maxTradeSize: number;

  // High conviction analysis
  asymmetricThreshold: number;
  asymmetricTradesCount: number;
  asymmetricVolume: number;
  asymmetricVolumePercent: number;

  // Market specialization
  strengths: {
    category: string;
    trades: number;
    winRate: number;
    totalPnl: number;
  }[];
  weaknesses: {
    category: string;
    trades: number;
    winRate: number;
    totalPnl: number;
  }[];

  // Entry odds breakdown
  entryOddsBreakdown: {
    range: string;
    trades: number;
  }[];

  // Trader label
  label: string;

  // Recent high-conviction trades (for reference)
  recentHighConvictionTrades: {
    timestamp: Date;
    side: string;
    market: string;
    outcome: string;
    price: number;
    usdcSize: number;
    sizeMultiplier: number;
    txHash: string;
  }[];
}

const TraderProfileSchema = new Schema<ITraderProfile>(
  {
    // Identity
    wallet: { type: String, required: true, lowercase: true, index: true },
    profiledAt: { type: Date, default: Date.now },
    periodDays: { type: Number, required: true },

    // Basic stats
    totalActivities: { type: Number },
    buyCount: { type: Number },
    sellCount: { type: Number },
    redeemCount: { type: Number },
    otherCount: { type: Number },

    // Classification
    tradesPerDay: { type: Number },
    volumeLabel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'] },
    buyRatio: { type: Number },
    strategyLabel: { type: String, enum: ['BUY_AND_HOLD', 'ACTIVE_TRADER', 'SWING_TRADER'] },

    // Performance
    closedPositionsCount: { type: Number },
    wins: { type: Number },
    losses: { type: Number },
    winRate: { type: Number },
    grossProfit: { type: Number },
    grossLoss: { type: Number },
    netPnl: { type: Number },
    profitFactor: { type: Number },

    // Open positions
    openPositionsCount: { type: Number },
    openValue: { type: Number },
    unrealizedPnl: { type: Number },

    // Trade sizing
    avgTradeSize: { type: Number },
    medianTradeSize: { type: Number },
    maxTradeSize: { type: Number },

    // High conviction
    asymmetricThreshold: { type: Number },
    asymmetricTradesCount: { type: Number },
    asymmetricVolume: { type: Number },
    asymmetricVolumePercent: { type: Number },

    // Market specialization
    strengths: [{
      category: String,
      trades: Number,
      winRate: Number,
      totalPnl: Number,
    }],
    weaknesses: [{
      category: String,
      trades: Number,
      winRate: Number,
      totalPnl: Number,
    }],

    // Entry odds
    entryOddsBreakdown: [{
      range: String,
      trades: Number,
    }],

    // Label
    label: { type: String },

    // High conviction trades
    recentHighConvictionTrades: [{
      timestamp: Date,
      side: String,
      market: String,
      outcome: String,
      price: Number,
      usdcSize: Number,
      sizeMultiplier: Number,
      txHash: String,
    }],
  },
  {
    timestamps: true,
    collection: 'polymarket-test-traderProfiles',
  }
);

// Index for looking up latest profile for a wallet
TraderProfileSchema.index({ wallet: 1, profiledAt: -1 });

export const TraderProfile = mongoose.models.TraderProfile || mongoose.model<ITraderProfile>('TraderProfile', TraderProfileSchema);
