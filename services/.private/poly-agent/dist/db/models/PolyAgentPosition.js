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
exports.PolyAgentPosition = void 0;
const mongoose_1 = __importStar(require("mongoose"));
const PolyAgentPositionSchema = new mongoose_1.Schema({
    // Identifiers
    targetWallet: { type: String, required: true, lowercase: true },
    botWallet: { type: String, required: true, lowercase: true },
    tokenId: { type: String, required: true },
    conditionId: { type: String, required: true },
    // Market info
    marketQuestion: { type: String },
    marketSlug: { type: String },
    outcome: { type: String },
    outcomeIndex: { type: Number },
    // Trader's position
    traderSize: { type: Number, default: 0 },
    traderAvgPrice: { type: Number, default: 0 },
    traderCurrentPrice: { type: Number, default: 0 },
    traderValueUsdc: { type: Number, default: 0 },
    traderPnL: { type: Number, default: 0 },
    traderPnLPercent: { type: Number, default: 0 },
    // Our position
    ourSize: { type: Number, default: 0 },
    ourAvgPrice: { type: Number, default: 0 },
    ourTargetSize: { type: Number, default: 0 },
    ourValueUsdc: { type: Number, default: 0 },
    ourPnL: { type: Number, default: 0 },
    ourPnLPercent: { type: Number, default: 0 },
    // Drift metrics
    entryDrift: { type: Number, default: 0 },
    currentDrift: { type: Number, default: 0 },
    priceVsTrader: { type: Number, default: 0 },
    // Status
    status: {
        type: String,
        enum: ['SYNCED', 'PENDING', 'PARTIAL', 'SKIPPED', 'UNDERWATER', 'CLOSED'],
        default: 'PENDING'
    },
    skipReason: { type: String },
    // Timestamps
    traderEnteredAt: { type: Date },
    ourEnteredAt: { type: Date },
    lastSyncedAt: { type: Date, default: Date.now },
    closedAt: { type: Date },
    // Execution details
    fillAttempts: { type: Number, default: 0 },
    totalSlippageUsdc: { type: Number, default: 0 },
}, {
    timestamps: true,
    collection: 'poly-agent-positions',
});
// Unique index: one position per token per trader-bot pair
PolyAgentPositionSchema.index({ targetWallet: 1, botWallet: 1, tokenId: 1 }, { unique: true });
// Index for finding positions by status
PolyAgentPositionSchema.index({ status: 1 });
// Index for finding positions by target wallet
PolyAgentPositionSchema.index({ targetWallet: 1 });
exports.PolyAgentPosition = mongoose_1.default.model('PolyAgentPosition', PolyAgentPositionSchema);
//# sourceMappingURL=PolyAgentPosition.js.map