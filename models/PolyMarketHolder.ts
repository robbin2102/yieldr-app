/**
 * PolyMarketHolder Model
 * Stores top holders for each Polymarket market token
 */

import mongoose, { Schema, Document, Model } from 'mongoose';

// Holder schema (embedded)
const HolderSchema = new Schema({
  proxyWallet: { type: String, required: true },
  name: String,
  pseudonym: String,
  bio: String,
  amount: { type: Number, required: true },
  displayUsernamePublic: Boolean,
  outcomeIndex: Number,
  profileImage: String,
  profileImageOptimized: String,
  asset: String,
}, { _id: false });

export interface IHolder {
  proxyWallet: string;
  name?: string;
  pseudonym?: string;
  bio?: string;
  amount: number;
  displayUsernamePublic?: boolean;
  outcomeIndex?: number;
  profileImage?: string;
  profileImageOptimized?: string;
  asset?: string;
}

export interface IPolyMarketHolder extends Document {
  // Market reference
  conditionId: string;
  marketId: string;
  marketQuestion?: string;
  marketSlug?: string;
  marketCategory?: string;
  marketEndDate?: Date;

  // Token info
  tokenId: string;
  outcome?: string;
  outcomeIndex?: number;

  // Holders array
  holders: IHolder[];

  // Aggregated stats
  totalHolders: number;
  totalAmount: number;
  topHolderAmount?: number;
  topHolderWallet?: string;

  // Tracking
  fetchedAt: Date;
}

const PolyMarketHolderSchema = new Schema<IPolyMarketHolder>({
  // === MARKET REFERENCE ===
  conditionId: { type: String, required: true, index: true },
  marketId: { type: String, required: true },
  marketQuestion: String,
  marketSlug: String,
  marketCategory: String,
  marketEndDate: Date,

  // === TOKEN INFO ===
  tokenId: { type: String, required: true },
  outcome: String,
  outcomeIndex: Number,

  // === HOLDERS ===
  holders: [HolderSchema],

  // === AGGREGATED STATS ===
  totalHolders: { type: Number, default: 0 },
  totalAmount: { type: Number, default: 0 },
  topHolderAmount: Number,
  topHolderWallet: String,

  // === TRACKING ===
  fetchedAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
  collection: 'polyMarketHolders',
});

// Compound index for uniqueness (one record per market token)
PolyMarketHolderSchema.index({ conditionId: 1, tokenId: 1 }, { unique: true });

// Index for querying by wallet
PolyMarketHolderSchema.index({ 'holders.proxyWallet': 1 });

// Index for finding markets by holder
PolyMarketHolderSchema.index({ marketEndDate: 1 });
PolyMarketHolderSchema.index({ marketCategory: 1 });

// Pre-save hook to calculate aggregated stats
PolyMarketHolderSchema.pre('save', function(next) {
  if (this.holders && this.holders.length > 0) {
    this.totalHolders = this.holders.length;
    this.totalAmount = this.holders.reduce((sum, h) => sum + (h.amount || 0), 0);

    // Find top holder
    const topHolder = this.holders.reduce((max, h) =>
      (h.amount > (max?.amount || 0)) ? h : max, this.holders[0]);

    if (topHolder) {
      this.topHolderAmount = topHolder.amount;
      this.topHolderWallet = topHolder.proxyWallet;
    }
  }
  next();
});

// Prevent model recompilation in development
const PolyMarketHolder: Model<IPolyMarketHolder> =
  mongoose.models.PolyMarketHolder || mongoose.model<IPolyMarketHolder>('PolyMarketHolder', PolyMarketHolderSchema);

export default PolyMarketHolder;
