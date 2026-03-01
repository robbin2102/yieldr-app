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
exports.config = void 0;
const dotenv = __importStar(require("dotenv"));
dotenv.config();
function required(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var: ${name}`);
    return val;
}
exports.config = {
    port: parseInt(process.env.PORT || '3000'),
    mongodbUri: required('MONGODB_URI'),
    taapi: {
        apiKey: required('TAAPI_API_KEY'),
        baseUrl: 'https://api.taapi.io',
        exchange: 'binancefutures',
        interval: '1h',
        // Pro plan: 30 req/15s → 2 req/s → 500ms min. Use 600ms for safety.
        rateDelayMs: parseInt(process.env.TAAPI_RATE_DELAY_MS || '600'),
    },
    coinglass: {
        apiKey: required('COINGLASS_API_KEY'),
        baseUrl: 'https://open-api-v4.coinglass.com',
        // Hobby plan: 30 req/min → 1 req/2s. Use 2200ms for safety.
        rateDelayMs: parseInt(process.env.COINGLASS_RATE_DELAY_MS || '2200'),
        // Token-bucket: 28 req/min to leave buffer
        tokensPerMinute: 28,
    },
    // Top N coins get full per-coin CoinGlass derivatives on cron
    fullDerivativesTier: 20,
    // Total tracked coins
    totalTrackedCoins: 100,
    // On-demand cache TTL (1 hour)
    onDemandCacheTtlMs: 60 * 60 * 1000,
};
//# sourceMappingURL=config.js.map