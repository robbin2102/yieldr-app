"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyTrade = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const copyTradeSchema = new mongoose_1.default.Schema({
    sourceWallet: { type: String, required: true, index: true, lowercase: true },
    traderLabel: { type: String, default: '' },
    txHash: { type: String, required: true, unique: true, index: true },
    conditionId: { type: String, index: true },
    tokenId: { type: String },
    title: { type: String, default: '' },
    outcome: { type: String, default: '' },
    side: { type: String, enum: ['BUY', 'SELL'], required: true },
    traderBetUsdc: { type: Number, default: 0 },
    traderPrice: { type: Number, default: 0 },
    traderSize: { type: Number, default: 0 },
    copyBetUsdc: { type: Number, default: 0 },
    skipReason: { type: String },
    skipDetail: { type: String },
    traderTs: { type: Number, required: true },
    detectedAt: { type: Number, required: true },
    discoveryLatencyMs: { type: Number, required: true },
    orderId: { type: String },
    submittedAt: { type: Number },
    submissionLatencyMs: { type: Number },
    filledAt: { type: Number },
    fillLatencyMs: { type: Number },
    totalLatencyMs: { type: Number },
    filledSize: { type: Number },
    avgFillPrice: { type: Number },
    filledUsdc: { type: Number },
    priceDrift: { type: Number },
    attempts: { type: Number },
    status: { type: String, enum: ['DETECTED', 'SKIPPED', 'EXECUTING', 'FILLED', 'PARTIAL', 'FAILED'], default: 'DETECTED', index: true },
    failReason: { type: String },
}, { timestamps: true, collection: 'ahf-copyTrades' });
copyTradeSchema.index({ sourceWallet: 1, detectedAt: -1 });
copyTradeSchema.index({ status: 1, createdAt: -1 });
exports.CopyTrade = mongoose_1.default.model('CopyTrade', copyTradeSchema, 'ahf-copyTrades');
//# sourceMappingURL=CopyTrade.js.map