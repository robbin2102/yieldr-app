"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CopyTrader = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const copyTraderSchema = new mongoose_1.default.Schema({
    wallet: { type: String, required: true, unique: true, index: true, lowercase: true },
    label: { type: String, required: true },
    specialty: { type: String, default: 'Unknown' },
    strategyLabel: { type: String, default: 'UNKNOWN' },
    roce: { type: Number, default: 0 },
    actsPerDay: { type: Number, default: 0 },
    avgBet: { type: Number, required: true },
    baseBetUsdc: { type: Number, default: 5 },
    maxBetUsdc: { type: Number, default: 20 },
    allocationUsdc: { type: Number, required: true },
    spentUsdc: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
    lastSeenTs: { type: Number, default: () => Math.floor(Date.now() / 1000) },
    lastPolledAt: { type: Date },
    detectorIntervalMs: { type: Number },
    tradesDetected: { type: Number, default: 0 },
    tradesAboveAvg: { type: Number, default: 0 },
    tradesExecuted: { type: Number, default: 0 },
    tradesSkipped: { type: Number, default: 0 },
    skipReasonCounts: { type: Map, of: Number, default: {} },
}, { timestamps: true, collection: 'ahf-copyTraders' });
exports.CopyTrader = mongoose_1.default.model('CopyTrader', copyTraderSchema, 'ahf-copyTraders');
//# sourceMappingURL=CopyTrader.js.map