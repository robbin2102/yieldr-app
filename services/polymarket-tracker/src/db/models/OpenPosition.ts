import mongoose, { Schema, Document } from 'mongoose';
import { OpenPosition as IOpenPosition } from '../../types/polymarket';

export interface OpenPositionDocument extends Omit<IOpenPosition, '_id'>, Document {}

const openPositionSchema = new Schema<OpenPositionDocument>(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    conditionId: {
      type: String,
      required: true,
      index: true,
    },
    asset: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    slug: {
      type: String,
      required: true,
    },
    outcome: {
      type: String,
      required: true,
    },
    outcomeIndex: {
      type: Number,
      required: true,
    },
    size: {
      type: Number,
      required: true,
    },
    avgPrice: {
      type: Number,
      required: true,
    },
    curPrice: {
      type: Number,
      required: true,
    },
    initialValue: {
      type: Number,
      required: true,
    },
    currentValue: {
      type: Number,
      required: true,
    },
    cashPnl: {
      type: Number,
      required: true,
    },
    percentPnl: {
      type: Number,
      required: true,
    },
    roi: {
      type: Number,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    redeemable: {
      type: Boolean,
      required: true,
      default: false,
    },
    fetchedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'polymarket_positions',
    timestamps: false, // We handle updatedAt manually
  }
);

// Compound index for efficient queries
openPositionSchema.index({ walletAddress: 1, conditionId: 1, asset: 1 }, { unique: true });

// Index for fetching all open positions for a wallet
openPositionSchema.index({ walletAddress: 1, updatedAt: -1 });

export const OpenPosition = mongoose.model<OpenPositionDocument>('OpenPosition', openPositionSchema);
