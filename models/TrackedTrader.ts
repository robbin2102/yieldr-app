import mongoose, { Schema, Document } from 'mongoose';

export interface ITrackedTrader extends Document {
  // Identity
  wallet: string;
  label: string;
  notes?: string;

  // Profile (cached from profiler)
  volumeLabel: 'LOW' | 'MEDIUM' | 'HIGH';
  strategyLabel: 'BUY_AND_HOLD' | 'ACTIVE_TRADER' | 'SWING_TRADER';
  specialty?: string;
  winRate?: number;
  profitFactor?: number;
  avgTradeSize?: number;  // For high-conviction detection (>10x = high conviction)

  // High-conviction alerts settings
  enableHighConvictionAlerts: boolean;
  asymmetricMultiplier: number; // Default 10 (trades >10x avg = high conviction)

  // Copy rules
  copyMultiplier: number; // 1.0 = same size, 0.5 = half size
  maxCopySize: number; // Max USDC per trade
  skipSmallBets: boolean;
  smallBetThreshold: number; // Skip bets below this USDC

  // Tracking state
  lastSeenTimestamp: number;
  isActive: boolean;

  // Stats
  totalAlerts: number;
  totalCopied: number;
  totalPnl: number;

  // Metadata
  addedAt: Date;
  lastUpdatedAt: Date;
  profiledAt?: Date;
}

const TrackedTraderSchema = new Schema<ITrackedTrader>(
  {
    // Identity
    wallet: { type: String, required: true, unique: true, lowercase: true },
    label: { type: String, required: true },
    notes: { type: String },

    // Profile
    volumeLabel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
    strategyLabel: { type: String, enum: ['BUY_AND_HOLD', 'ACTIVE_TRADER', 'SWING_TRADER'], default: 'BUY_AND_HOLD' },
    specialty: { type: String },
    winRate: { type: Number },
    profitFactor: { type: Number },
    avgTradeSize: { type: Number },

    // High-conviction alerts settings
    enableHighConvictionAlerts: { type: Boolean, default: false },
    asymmetricMultiplier: { type: Number, default: 10 },

    // Copy rules
    copyMultiplier: { type: Number, default: 1.0 },
    maxCopySize: { type: Number, default: 10000 }, // High default - user decides manually
    skipSmallBets: { type: Boolean, default: true },
    smallBetThreshold: { type: Number, default: 50 },

    // Tracking state
    lastSeenTimestamp: { type: Number, default: () => Math.floor(Date.now() / 1000) },
    isActive: { type: Boolean, default: true },

    // Stats
    totalAlerts: { type: Number, default: 0 },
    totalCopied: { type: Number, default: 0 },
    totalPnl: { type: Number, default: 0 },

    // Metadata
    addedAt: { type: Date, default: Date.now },
    lastUpdatedAt: { type: Date, default: Date.now },
    profiledAt: { type: Date },
  },
  {
    timestamps: false,
    collection: 'polymarket-trackedTraders',
  }
);

export const TrackedTrader = mongoose.models.TrackedTrader || mongoose.model<ITrackedTrader>('TrackedTrader', TrackedTraderSchema);
