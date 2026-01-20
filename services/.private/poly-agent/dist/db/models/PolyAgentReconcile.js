"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PolyAgentReconcile = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const polyAgentReconcileSchema = new mongoose_1.default.Schema({
    // When this check ran
    checkedAt: { type: Date, required: true, index: true },
    // Market info
    conditionId: { type: String, required: true, index: true },
    title: String,
    outcome: String,
    // Position comparison
    traderPosition: {
        size: Number,
        avgPrice: Number,
    },
    expectedPosition: {
        size: Number, // traderPosition × copyRatio
    },
    actualPosition: {
        size: Number,
        avgPrice: Number,
    },
    // Gap
    gapSize: Number, // expected - actual
    gapPercent: Number, // (gap / expected) × 100
    gapDirection: { type: String, enum: ['UNDER', 'OVER', 'OK'] },
}, { timestamps: true });
// Index for finding gaps
polyAgentReconcileSchema.index({ gapDirection: 1, checkedAt: -1 });
exports.PolyAgentReconcile = mongoose_1.default.model('PolyAgentReconcile', polyAgentReconcileSchema, 'poly-agent-reconcile');
//# sourceMappingURL=PolyAgentReconcile.js.map