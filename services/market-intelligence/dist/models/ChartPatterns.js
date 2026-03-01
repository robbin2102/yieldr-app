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
const ChartPatternsSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, uppercase: true },
    updated_at: { type: Date, default: Date.now },
    detected_patterns: [{
            pattern: { type: String, required: true },
            timeframe: { type: String, default: '1h' },
            status: { type: String, enum: ['forming', 'confirmed', 'failed'], default: 'forming' },
            key_levels: {
                neckline: { type: Number, default: null },
                breakout: { type: Number, default: null },
                target: { type: Number, default: null },
                stop: { type: Number, default: null },
            },
            confidence: { type: Number, min: 0, max: 1, default: 0.5 },
            detected_at: { type: Date, default: Date.now },
            volume_confirmation: { type: Boolean, default: false },
            notes: { type: String, default: '' },
        }],
    active_count: { type: Number, default: 0 },
}, { collection: 'chart_patterns', timestamps: false });
ChartPatternsSchema.index({ symbol: 1 }, { unique: true });
exports.default = mongoose_1.default.models.ChartPatterns ||
    mongoose_1.default.model('ChartPatterns', ChartPatternsSchema);
//# sourceMappingURL=ChartPatterns.js.map