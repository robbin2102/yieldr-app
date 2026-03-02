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
/**
 * npm run fetch-macro
 * Fetches and saves the daily macro snapshot (ETF flows, fear/greed, stablecoin mcap).
 * Prints all fetched values and the MongoDB _id of the saved document.
 */
const dotenv = __importStar(require("dotenv"));
dotenv.config({ path: '../../.env.local' });
const db_1 = require("../db");
const macro_builder_1 = require("../processors/macro-builder");
// ─── Formatting helpers ────────────────────────────────────────────────────────
function usd(val) {
    if (val == null)
        return 'N/A';
    const abs = Math.abs(val);
    const sign = val >= 0 ? '+' : '-';
    if (abs >= 1e9)
        return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6)
        return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3)
        return `${sign}$${(abs / 1e3).toFixed(1)}K`;
    return `${sign}$${abs.toFixed(2)}`;
}
function n(val, decimals = 4) {
    if (val == null)
        return 'N/A';
    return val.toFixed(decimals);
}
// ─── Rich console output ───────────────────────────────────────────────────────
function printMacroSnapshot(docId, doc) {
    const date = doc.date.toISOString().split('T')[0];
    const btcEtf = doc.btc_etf;
    const ethEtf = doc.eth_etf;
    const fg = doc.fear_greed;
    const stable = doc.stablecoin_mcap;
    const premium = doc.coinbase_premium;
    const LINE = '═'.repeat(70);
    console.log(`\n${LINE}`);
    console.log(`  MACRO DAILY  |  ${date}  |  Mongo _id: ${docId}`);
    console.log(LINE);
    // ── Fear & Greed ──────────────────────────────────────────────────────
    console.log('\nFEAR & GREED');
    console.log(`  Value:          ${fg?.value ?? 'N/A'}`);
    console.log(`  Classification: ${fg?.classification ?? 'N/A'}`);
    // ── BTC ETF ───────────────────────────────────────────────────────────
    console.log('\nBTC ETF');
    console.log(`  Total flow:   ${usd(btcEtf?.total_flow_usd)}`);
    console.log(`  Net assets:   ${usd(btcEtf?.net_assets_usd)}`);
    const btcFlows = btcEtf?.flows_by_ticker ?? [];
    if (btcFlows.length > 0) {
        console.log('  By ticker:');
        for (const f of btcFlows) {
            console.log(`    ${f.ticker.padEnd(6)} ${usd(f.flow_usd)}`);
        }
    }
    // ── ETH ETF ───────────────────────────────────────────────────────────
    console.log('\nETH ETF');
    console.log(`  Total flow:   ${usd(ethEtf?.total_flow_usd)}`);
    const ethFlows = ethEtf?.flows_by_ticker ?? [];
    if (ethFlows.length > 0) {
        console.log('  By ticker:');
        for (const f of ethFlows) {
            console.log(`    ${f.ticker.padEnd(6)} ${usd(f.flow_usd)}`);
        }
    }
    // ── Coinbase Premium ──────────────────────────────────────────────────
    console.log('\nCOINBASE PREMIUM');
    console.log(`  BTC: ${n(premium?.btc)}`);
    console.log(`  ETH: ${premium?.eth != null ? n(premium.eth) : 'N/A'}`);
    // ── Stablecoin Mcap ───────────────────────────────────────────────────
    console.log('\nSTABLECOIN MARKET CAP');
    console.log(`  Total:     ${usd(stable?.total_usd)}`);
    console.log(`  Change 24h:${usd(stable?.change_24h_usd)}`);
    console.log('');
}
// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    await (0, db_1.connectDB)();
    try {
        const { _id, doc } = await (0, macro_builder_1.buildAndSaveMacroDaily)();
        printMacroSnapshot(_id, doc);
    }
    catch (err) {
        console.error('✗ fetch-macro failed:', err.message ?? err);
        await (0, db_1.disconnectDB)();
        process.exit(1);
    }
    await (0, db_1.disconnectDB)();
    process.exit(0);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=fetch-macro.js.map