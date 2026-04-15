import mongoose, { Document, Schema } from 'mongoose';

/**
 * Universal Position Model
 * Stores ALL open positions across all platforms: Avantis, Hyperliquid, LP, Predictions, etc.
 * Updated by:
 *  - Python service (full sync on page refresh)
 *  - Node.js real-time listener (add on OPEN, remove on CLOSE)
 */

export interface IPosition extends Document {
  walletAddress: string;
  type: 'PERP' | 'LP' | 'PREDICTION';
  platform: 'Avantis' | 'Hyperliquid' | 'Aero' | 'Aerodrome' | 'Uniswap' | 'Unknown';

  // Common Position Fields
  positionId: string | number; // tradeIndex for Avantis, unique ID for others
  status: 'active' | 'closed';

  // PERP-specific fields (Avantis, Hyperliquid)
  pair?: string; // BTC, ETH, SOL, etc.
  direction?: 'LONG' | 'SHORT';
  leverage?: number;
  positionSize?: number; // Total position size in USDC
  margin?: number; // Collateral
  entryPrice?: number;
  currentPrice?: number;
  liquidationPrice?: number;
  pnl?: number;
  roi?: number;

  // LP-specific fields
  pool?: string;
  chain?: string;
  liquidity?: number;
  token0?: string;
  token1?: string;
  apr?: number;
  unclaimedFees?: number;

  // Agent wallet that holds the position (for agent-executed trades)
  agentWallet?: string;

  // Metadata
  createdAt: Date;
  updatedAt: Date;

  // Transaction hash
  txHash?: string;
}

const PositionSchema: Schema = new Schema(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['PERP', 'LP', 'PREDICTION'],
      index: true,
    },
    platform: {
      type: String,
      required: true,
      enum: ['Avantis', 'Hyperliquid', 'Aero', 'Aerodrome', 'Uniswap', 'Unknown'],
      index: true,
    },
    positionId: {
      type: Schema.Types.Mixed, // Can be string or number
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'closed'],
      default: 'active',
    },

    // PERP fields
    pair: String,
    direction: {
      type: String,
      enum: ['LONG', 'SHORT'],
    },
    leverage: Number,
    positionSize: Number,
    margin: Number,
    entryPrice: Number,
    currentPrice: Number,
    liquidationPrice: Number,
    pnl: Number,
    roi: Number,

    // LP fields
    pool: String,
    chain: String,
    liquidity: Number,
    token0: String,
    token1: String,
    apr: Number,
    unclaimedFees: Number,

    // Agent wallet (for agent-executed trades via Bankr)
    agentWallet: { type: String, lowercase: true },

    // Metadata
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
    txHash: String,
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
PositionSchema.index({ walletAddress: 1, platform: 1 });
PositionSchema.index({ walletAddress: 1, type: 1 });
PositionSchema.index({ platform: 1, positionId: 1 }); // For matching CLOSE events
PositionSchema.index({ walletAddress: 1, status: 1 });

export default mongoose.models.Position ||
  mongoose.model<IPosition>('Position', PositionSchema);
