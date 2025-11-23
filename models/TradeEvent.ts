import mongoose from 'mongoose';

/**
 * Trade Event Schema
 * Stores Avantis trading events from blockchain
 */
const TradeEventSchema = new mongoose.Schema({
  // PRIMARY KEY - Unique trade identifier (trader-pairIndex-tradeIndex)
  // This links open and close events for the same position
  tradeKey: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Trade status
  status: {
    type: String,
    enum: ['PENDING_OPEN', 'OPEN', 'PENDING_CLOSE', 'CLOSED'],
    required: true,
    index: true,
  },

  // Trader information
  trader: {
    type: String,
    required: true,
    lowercase: true,
    index: true,
  },

  // Platform
  platform: {
    type: String,
    default: 'Avantis',
    index: true,
  },

  // Trading pair
  pairIndex: {
    type: Number,
    required: true,
  },

  pairSymbol: {
    type: String, // e.g., "ETH/USD"
  },

  // Trade index (from contract - used in tradeKey)
  tradeIndex: {
    type: Number,
    required: true,
  },

  // Trade direction (LONG or SHORT only)
  direction: {
    type: String,
    enum: ['LONG', 'SHORT'],
    required: true,
  },

  // Order IDs for reference (open and close have different orderIds)
  openOrderId: {
    type: String,
  },

  closeOrderId: {
    type: String,
  },

  // --- TIMESTAMPS (simplified to 2 fields only) ---
  // When position opened (from MarketExecuted open=true block timestamp)
  initiatedAt: {
    type: Date,
  },

  // When position closed (from MarketExecuted open=false block timestamp)
  closedAt: {
    type: Date,
  },

  // --- Transaction hashes for reference ---
  openTxHash: {
    type: String,
  },

  closeTxHash: {
    type: String,
  },

  // --- Block numbers for reference ---
  openBlockNumber: {
    type: Number,
    index: true,
  },

  closeBlockNumber: {
    type: Number,
  },

  // --- Trade details (from open execution) ---
  collateralUsdc: {
    type: Number,
  },

  positionSizeUsdc: {
    type: Number,
  },

  leverage: {
    type: Number,
  },

  openPrice: {
    type: Number,
  },

  tp: {
    type: Number,
  },

  sl: {
    type: Number,
  },

  // --- Close data (when position closes) ---
  closePrice: {
    type: Number,
  },

  pnlUsdc: {
    type: Number, // Profit/Loss in USDC (can be negative)
  },

  roi: {
    type: Number, // Return on investment percentage (can be negative)
  },

  // --- Computed fields ---
  durationSeconds: {
    type: Number,
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
  },

  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound indexes for efficient querying
TradeEventSchema.index({ trader: 1, initiatedAt: -1 });
TradeEventSchema.index({ status: 1, trader: 1 });
TradeEventSchema.index({ trader: 1, status: 1, initiatedAt: -1 });
TradeEventSchema.index({ trader: 1, pairIndex: 1, tradeIndex: 1 }); // For finding trades by composite key

// Update 'updatedAt' on every save
TradeEventSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Use custom collection name 'historicaltrades' instead of default 'tradeevents'
export default mongoose.models.TradeEvent ||
  mongoose.model('TradeEvent', TradeEventSchema, 'historicaltrades');
