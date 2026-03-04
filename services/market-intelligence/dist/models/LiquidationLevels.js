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
const LiquidationLevelsSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, uppercase: true },
    updated_at: { type: Date, default: Date.now },
    current_price: { type: Number, default: null },
    price_buckets: [{
            price_low: Number, price_high: Number,
            long_liq_usd: { type: Number, default: 0 },
            short_liq_usd: { type: Number, default: 0 },
            total_usd: { type: Number, default: 0 },
            count: { type: Number, default: 0 },
            _id: false,
        }],
    total_long_liq_24h: { type: Number, default: null },
    total_short_liq_24h: { type: Number, default: null },
    heaviest_cluster: {
        price_range: { type: String, default: null },
        total_usd: { type: Number, default: null },
        side: { type: String, default: null },
    },
    nearest_cluster_distance_pct: { type: Number, default: null },
}, { collection: 'liquidation_levels', timestamps: false });
LiquidationLevelsSchema.index({ symbol: 1 }, { unique: true });
exports.default = mongoose_1.default.models.LiquidationLevels ||
    mongoose_1.default.model('LiquidationLevels', LiquidationLevelsSchema);
//# sourceMappingURL=LiquidationLevels.js.map