import mongoose from 'mongoose';

/**
 * Closed Position Schema
 *
 * Stores complete history of closed positions with performance metrics.
 * Created when a position is detected as closed during monitoring.
 *
 * Used for:
 * - Historical performance analysis
 * - Win rate calculations
 * - Trading pattern analysis
 * - Risk metrics computation
 */

const ClosedPositionSchema = new mongoose.Schema({
  // Identification
  positionId: {
    type: String,
    required: true,
    index: true
  },
  walletAddress: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    required: true,
    index: true
  },

  // Platform & Asset
  platform: {
    type: String,
    required: true,
    enum: ['avantis', 'hyperliquid', 'aerodrome', 'uniswap'],
    index: true
  },
  asset: {
    type: String,
    required: true,
    index: true  // For asset-specific analytics
  },
  pair: String,

  // Position Type
  type: {
    type: String,
    required: true,
    enum: ['PERP', 'LP']
  },

  // PERP-specific data
  direction: String,  // LONG, SHORT
  leverage: Number,
  entryPrice: Number,
  exitPrice: Number,
  avgPrice: Number,   // Average exit price if closed in multiple fills
  liquidationPrice: Number,

  // LP-specific data
  token0: String,
  token1: String,
  liquidityAdded: Number,
  liquidityRemoved: Number,

  // Position sizing
  positionSize: Number,  // USD value of position
  margin: Number,        // Margin/capital used

  // Performance metrics
  pnl: {
    type: Number,
    required: true,
    index: true  // For sorting by profitability
  },
  roi: {
    type: Number,
    required: true,
    index: true
  },
  pnlPercentage: Number,  // PnL as % of position size

  // Fees
  openFee: Number,
  closeFee: Number,
  fundingFees: Number,  // Cumulative funding fees (PERP only)
  totalFees: Number,

  // Timing
  openedAt: {
    type: Date,
    required: true,
    index: true  // For time-based queries
  },
  closedAt: {
    type: Date,
    required: true,
    index: true
  },
  holdDuration: Number,  // Duration in seconds

  // Exit reason
  exitReason: {
    type: String,
    enum: ['manual', 'stop_loss', 'take_profit', 'liquidation', 'lp_withdrawal', 'unknown'],
    default: 'unknown'
  },

  // Risk management
  maxDrawdown: Number,      // Max unrealized loss during position lifetime
  maxProfitReached: Number, // Max unrealized profit reached
  stopLossPrice: Number,
  takeProfitPrice: Number,

  // Market context (for analysis)
  marketConditions: {
    volatility: Number,      // Market volatility at entry
    trend: String,           // bullish, bearish, sideways
    volume: Number,          // Trading volume
  },

  // Metadata
  detectedAt: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for common queries
ClosedPositionSchema.index({ managerId: 1, closedAt: -1 });  // Recent positions for a manager
ClosedPositionSchema.index({ managerId: 1, asset: 1, closedAt: -1 });  // Asset-specific history
ClosedPositionSchema.index({ managerId: 1, pnl: -1 });  // Top/worst trades
ClosedPositionSchema.index({ walletAddress: 1, platform: 1, closedAt: -1 });

// Indexes for win rate and performance calculations
ClosedPositionSchema.index({ managerId: 1, pnl: 1, closedAt: -1 });
ClosedPositionSchema.index({ managerId: 1, asset: 1, pnl: 1 });

export default mongoose.models.ClosedPosition || mongoose.model('ClosedPosition', ClosedPositionSchema);
