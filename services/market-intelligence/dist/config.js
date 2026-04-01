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
const path = __importStar(require("path"));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });
function required(name) {
    const val = process.env[name];
    if (!val)
        throw new Error(`Missing required env var: ${name}`);
    return val;
}
// NOTE: apiKey and mongodbUri are lazy getters so they are evaluated only when
// first accessed (inside running functions), NOT at module load time. This lets
// the HTTP health-check server start before env-var validation occurs, which is
// required for Railway's health-check to pass on deployment.
exports.config = {
    port: parseInt(process.env.PORT || '3000'),
    get mongodbUri() { return required('MONGODB_URI'); },
    taapi: {
        get apiKey() { return required('TAAPI_API_KEY'); },
        baseUrl: 'https://api.taapi.io',
        exchange: 'binancefutures',
        interval: '1h',
        rateDelayMs: parseInt(process.env.TAAPI_RATE_DELAY_MS || '600'),
    },
    coinglass: {
        enabled: process.env.COINGLASS_ENABLED === 'true',
        get apiKey() { return required('COINGLASS_API_KEY'); },
        baseUrl: 'https://open-api-v4.coinglass.com',
        rateDelayMs: parseInt(process.env.COINGLASS_RATE_DELAY_MS || '2200'),
        tokensPerMinute: parseInt(process.env.COINGLASS_TOKENS_PER_MINUTE || '15'),
    },
    binance: {
        // Override to use alternative Binance endpoints if primary returns 451 (geo-restriction).
        // Binance alternatives: api1.binance.com, api2.binance.com, api3.binance.com, api4.binance.com
        // For US-hosted deployments use: api.binance.us
        spotBaseUrl: process.env.BINANCE_SPOT_BASE_URL || 'https://api.binance.com',
    },
    fullDerivativesTier: 20,
    totalTrackedCoins: 100,
    onDemandCacheTtlMs: 60 * 60 * 1000,
};
//# sourceMappingURL=config.js.map