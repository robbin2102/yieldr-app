"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const MarketStructureHistorySchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, uppercase: true },
    updated_at: { type: Date, default: Date.now },
    swing_points: [{
            type: { type: String, enum: ['high', 'low'], required: true },
            price: { type: Number, required: true },
            timestamp: { type: Date, required: true },
            timeframe: { type: String, default: '1h' },
            _id: false,
        }],
    structure_events: [{
            type: { type: String, enum: ['bos', 'choch'], required: true },
            direction: { type: String, enum: ['bullish', 'bearish'], required: true },
            price: { type: Number, required: true },
            timestamp: { type: Date, required: true },
            _id: false,
        }],
    trend: { type: String, enum: ['uptrend', 'downtrend', 'range'], default: 'range' },
    last_hh: { type: Number, default: null },
    last_hl: { type: Number, default: null },
    last_lh: { type: Number, default: null },
    last_ll: { type: Number, default: null },
}, { collection: 'market_structure_history', timestamps: false });
MarketStructureHistorySchema.index({ symbol: 1 }, { unique: true });
exports.default = mongoose_1.default.models.MarketStructureHistory ||
    mongoose_1.default.model('MarketStructureHistory', MarketStructureHistorySchema);
//# sourceMappingURL=MarketStructureHistory.js.map