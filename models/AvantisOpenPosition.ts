/**
 * Avantis Open Position Model
 * Tracks currently open positions for quick querying
 * Separate from historicaltrades (which is an event log)
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface IAvantisOpenPosition extends Document {
  // Primary key - orderId from OPEN event
  orderId: string;

  // Trader information
  trader: string;
  platform: string;

  // Trading pair
  pairIndex: number;
  pairSymbol: string;
  tradeIndex: number;
  direction: 'LONG' | 'SHORT';

  // Position details at open
  openPrice: number;
  collateralUsdc: number;
  positionSizeUsdc: number;
  leverage: number;
  tp: number;
  sl: number;

  // Blockchain metadata
  openedAt: Date;
  openTxHash: string;
  openBlockNumber: number;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

const AvantisOpenPositionSchema = new Schema<IAvantisOpenPosition>(
  {
    // PRIMARY KEY - orderId from MarketExecuted/LimitExecuted OPEN event
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Trader information
    trader: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    platform: {
      type: String,
      required: true,
      default: 'Avantis',
      index: true,
    },

    // Trading pair
    pairIndex: {
      type: Number,
      required: true,
      index: true,
    },
    pairSymbol: {
      type: String,
      required: true,
      index: true,
    },
    tradeIndex: {
      type: Number,
      required: true,
    },
    direction: {
      type: String,
      enum: ['LONG', 'SHORT'],
      required: true,
      index: true,
    },

    // Position details at open
    openPrice: {
      type: Number,
      required: true,
    },
    collateralUsdc: {
      type: Number,
      required: true,
    },
    positionSizeUsdc: {
      type: Number,
      required: true,
    },
    leverage: {
      type: Number,
      required: true,
    },
    tp: {
      type: Number,
      required: true,
    },
    sl: {
      type: Number,
      required: true,
    },

    // Blockchain metadata
    openedAt: {
      type: Date,
      required: true,
      index: true,
    },
    openTxHash: {
      type: String,
      required: true,
    },
    openBlockNumber: {
      type: Number,
      required: true,
      index: true,
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    collection: 'avantis-openpositions',
  }
);

// Compound indexes for common queries
AvantisOpenPositionSchema.index({ trader: 1, pairSymbol: 1 });
AvantisOpenPositionSchema.index({ trader: 1, openedAt: -1 });
AvantisOpenPositionSchema.index({ platform: 1, trader: 1 });

export default mongoose.models.AvantisOpenPosition ||
  mongoose.model<IAvantisOpenPosition>('AvantisOpenPosition', AvantisOpenPositionSchema);
