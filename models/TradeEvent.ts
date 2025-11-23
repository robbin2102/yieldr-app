import mongoose from 'mongoose';

/**
 * Trade Event Schema - Simplified
 * Stores MarketExecuted events from Avantis blockchain
 * Each event (OPEN or CLOSE) is stored independently
 */
const TradeEventSchema = new mongoose.Schema({
  // PRIMARY KEY - orderId from MarketExecuted event (unique per event)
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // Event type: 'OPEN' or 'CLOSE'
  eventType: {
    type: String,
    enum: ['OPEN', 'CLOSE'],
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
    index: true,
  },

  pairSymbol: {
    type: String, // e.g., "ETH/USD"
  },

  // Trade index (from contract)
  tradeIndex: {
    type: Number,
    required: true,
  },

  // Trade direction (LONG or SHORT)
  direction: {
    type: String,
    enum: ['LONG', 'SHORT'],
    required: true,
  },

  // Event timestamp (from block)
  timestamp: {
    type: Date,
    required: true,
    index: true,
  },

  // Transaction hash
  txHash: {
    type: String,
    required: true,
  },

  // Block number
  blockNumber: {
    type: Number,
    required: true,
    index: true,
  },

  // --- Trade details (present in all events) ---
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

  // --- OPEN event specific fields ---
  openPrice: {
    type: Number,
  },

  tp: {
    type: Number,
  },

  sl: {
    type: Number,
  },

  // --- CLOSE event specific fields ---
  closePrice: {
    type: Number,
  },

  pnlUsdc: {
    type: Number, // Profit/Loss in USDC (can be negative)
  },

  roi: {
    type: Number, // Return on investment percentage (can be negative)
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
TradeEventSchema.index({ trader: 1, timestamp: -1 });
TradeEventSchema.index({ trader: 1, eventType: 1, timestamp: -1 });
TradeEventSchema.index({ trader: 1, pairIndex: 1, eventType: 1 });

// Update 'updatedAt' on every save
TradeEventSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Use custom collection name 'historicaltrades' instead of default 'tradeevents'
export default mongoose.models.TradeEvent ||
  mongoose.model('TradeEvent', TradeEventSchema, 'historicaltrades');
