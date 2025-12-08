import mongoose, { Schema, Document } from 'mongoose';

export interface IMonitoredWallet extends Document {
  walletAddress: string;
  market: 'LP' | 'PERP';
  platform: 'HYPERLIQUID' | null;
  status: 'active' | 'stopped';
  monitorInterval: number; // milliseconds
  lastChecked: Date;
  nextCheck: Date;
  userId?: string;
  createdAt: Date;
}

const MonitoredWalletSchema = new Schema<IMonitoredWallet>({
  walletAddress: {
    type: String,
    required: true,
    lowercase: true
  },
  market: {
    type: String,
    enum: ['LP', 'PERP'],
    required: true
  },
  platform: {
    type: String,
    enum: ['HYPERLIQUID', null],
    default: null
  },
  status: {
    type: String,
    enum: ['active', 'stopped'],
    default: 'active'
  },
  monitorInterval: {
    type: Number,
    required: true
  },
  lastChecked: {
    type: Date,
    default: Date.now
  },
  nextCheck: {
    type: Date,
    required: true
  },
  userId: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for efficient queries
MonitoredWalletSchema.index({ status: 1, nextCheck: 1 });
MonitoredWalletSchema.index({ walletAddress: 1, market: 1, platform: 1 }, { unique: true });

export default mongoose.models.MonitoredWallet ||
  mongoose.model<IMonitoredWallet>('MonitoredWallet', MonitoredWalletSchema);
