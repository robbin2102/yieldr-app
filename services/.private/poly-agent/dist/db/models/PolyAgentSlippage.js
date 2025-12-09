"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolyAgentSlippage = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const polyAgentSlippageSchema = new mongoose_1.default.Schema({
    // Singleton document - only one row with _id='current'
    _id: { type: String, default: 'current' },
    // Running totals
    totalExpectedCost: { type: Number, default: 0 }, // Sum of (traderPrice × ourQty)
    totalActualCost: { type: Number, default: 0 }, // Sum of (ourFillPrice × ourQty)
    bufferUsdc: { type: Number, default: 0 }, // totalExpectedCost - totalActualCost
    // Stats
    totalTrades: { type: Number, default: 0 },
    totalPositiveSlippage: { type: Number, default: 0 }, // Times we paid less
    totalNegativeSlippage: { type: Number, default: 0 }, // Times we paid more
    // Last update
    lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });
exports.PolyAgentSlippage = mongoose_1.default.model('PolyAgentSlippage', polyAgentSlippageSchema, 'poly-agent-slippage');
//# sourceMappingURL=PolyAgentSlippage.js.map