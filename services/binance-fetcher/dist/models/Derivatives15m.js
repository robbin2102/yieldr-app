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
const LSRatioSchema = new mongoose_1.Schema({
    long_pct: Number, // long percentage (0–100)
    short_pct: Number, // short percentage (0–100)
    ratio: Number, // longShortRatio raw value from Binance
}, { _id: false });
const Derivatives15mSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, uppercase: true },
    pair: { type: String, required: true }, // e.g. BTCUSDT
    timestamp: { type: Date, required: true },
    open_interest_usdt: Number, // sumOpenInterestValue from openInterestHist
    // Long/short ratios — all values in percent (0–100), ratio is raw decimal
    long_short_global: LSRatioSchema,
    long_short_top_accounts: LSRatioSchema,
    long_short_top_positions: LSRatioSchema,
}, { collection: 'binance_derivatives_15m', timestamps: false });
Derivatives15mSchema.index({ symbol: 1, timestamp: -1 }, { unique: true });
Derivatives15mSchema.index({ timestamp: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
exports.default = mongoose_1.default.models.Derivatives15m ||
    mongoose_1.default.model('Derivatives15m', Derivatives15mSchema);
