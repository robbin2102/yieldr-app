import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Portfolio History Model
 *
 * Stores historical portfolio data from Hyperliquid portfolio API
 * Captures account value and PnL history at regular intervals (60s)
 * Used for computing time-based metrics (24h, 7d, 30d, 90d)
 */

export interface IPortfolioHistory extends Document {
  managerId: string;
  walletAddress: string;
  platform: 'hyperliquid';

  // Snapshot timestamp
  timestamp: Date;

  // Current values at this snapshot
  accountValue: number;
  pnl: number;

  // Historical data points from API
  // Format: [[timestamp, value], [timestamp, value], ...]
  dayData: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  weekData: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  monthData: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  allTimeData: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  // Perp-specific data
  perpDayData?: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  perpWeekData?: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  perpMonthData?: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  perpAllTimeData?: {
    accountValueHistory: [number, string][];
    pnlHistory: [number, string][];
    vlm: string;
  };

  // Metadata
  createdAt: Date;
}

const PortfolioHistorySchema = new Schema<IPortfolioHistory>(
  {
    managerId: {
      type: String,
      required: true,
      index: true,
    },
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    platform: {
      type: String,
      required: true,
      enum: ['hyperliquid'],
      default: 'hyperliquid',
    },
    timestamp: {
      type: Date,
      required: true,
      index: true,
    },
    accountValue: {
      type: Number,
      required: true,
      default: 0,
    },
    pnl: {
      type: Number,
      required: true,
      default: 0,
    },
    dayData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    weekData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    monthData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    allTimeData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    perpDayData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    perpWeekData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    perpMonthData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    perpAllTimeData: {
      accountValueHistory: [[Number, String]],
      pnlHistory: [[Number, String]],
      vlm: String,
    },
    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    collection: 'portfoliohistory',
    timestamps: false, // We manage timestamp manually
  }
);

// Compound indexes for efficient queries
PortfolioHistorySchema.index({ managerId: 1, timestamp: -1 });
PortfolioHistorySchema.index({ walletAddress: 1, timestamp: -1 });
PortfolioHistorySchema.index({ managerId: 1, platform: 1, timestamp: -1 });

// Prevent duplicate entries for same timestamp
PortfolioHistorySchema.index(
  { managerId: 1, walletAddress: 1, timestamp: 1 },
  { unique: true }
);

const PortfolioHistory: Model<IPortfolioHistory> =
  mongoose.models.PortfolioHistory ||
  mongoose.model<IPortfolioHistory>('PortfolioHistory', PortfolioHistorySchema);

export default PortfolioHistory;
