import mongoose, { Schema, Document } from 'mongoose';
import { ClosedPosition as IClosedPosition } from '../../types/polymarket';

export interface ClosedPositionDocument extends Omit<IClosedPosition, '_id'>, Document {}

const closedPositionSchema = new Schema<ClosedPositionDocument>(
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
    totalBought: {
      type: Number,
      required: true,
    },
    avgPrice: {
      type: Number,
      required: true,
    },
    realizedPnl: {
      type: Number,
      required: true,
    },
    totalBet: {
      type: Number,
      required: true,
    },
    amountWon: {
      type: Number,
      required: true,
    },
    roi: {
      type: Number,
      required: true,
    },
    won: {
      type: Boolean,
      required: true,
    },
    closedAt: {
      type: Date,
      required: true,
      index: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    fetchedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'polymarket_closedpositions',
    timestamps: false,
  }
);

// Compound index for unique closed positions
closedPositionSchema.index({ walletAddress: 1, conditionId: 1, asset: 1 }, { unique: true });

// Index for querying by wallet and time
closedPositionSchema.index({ walletAddress: 1, closedAt: -1 });

export const ClosedPosition = mongoose.model<ClosedPositionDocument>(
  'ClosedPosition',
  closedPositionSchema
);
