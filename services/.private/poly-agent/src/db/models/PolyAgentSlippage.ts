import mongoose from 'mongoose';

const polyAgentSlippageSchema = new mongoose.Schema({
  // Singleton document - only one row with _id='current'
  _id: { type: String, default: 'current' },

  // Running totals
  totalExpectedCost: { type: Number, default: 0 },   // Sum of (traderPrice × ourQty)
  totalActualCost: { type: Number, default: 0 },     // Sum of (ourFillPrice × ourQty)
  bufferUsdc: { type: Number, default: 0 },          // totalExpectedCost - totalActualCost

  // Stats
  totalTrades: { type: Number, default: 0 },
  totalPositiveSlippage: { type: Number, default: 0 },  // Times we paid less
  totalNegativeSlippage: { type: Number, default: 0 },  // Times we paid more

  // Last update
  lastUpdated: { type: Date, default: Date.now },

}, { timestamps: true });

export const PolyAgentSlippage = mongoose.model('PolyAgentSlippage', polyAgentSlippageSchema, 'poly-agent-slippage');
