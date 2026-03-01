"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndSaveMacroDaily = buildAndSaveMacroDaily;
const logger_1 = require("../utils/logger");
const coinglass_1 = require("../fetchers/coinglass");
const MacroDaily_1 = __importDefault(require("../models/MacroDaily"));
/**
 * Fetch all daily macro data from CoinGlass and upsert to macro_daily collection.
 */
async function buildAndSaveMacroDaily() {
    logger_1.logger.info('Macro', 'Building daily macro snapshot');
    try {
        const { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap } = await (0, coinglass_1.fetchMacroData)();
        const premium = await (0, coinglass_1.fetchCoinbasePremium)();
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const doc = {
            date: today,
            btc_etf: buildEtfFlows(btcEtfFlows, btcEtfNetAssets),
            eth_etf: buildEtfFlows(ethEtfFlows, null),
            coinbase_premium: premium,
            fear_greed: buildFearGreed(fearGreed),
            stablecoin_mcap: buildStablecoinMcap(stablecoinMcap),
        };
        await MacroDaily_1.default.findOneAndUpdate({ date: today }, { $set: doc }, { upsert: true, new: true });
        logger_1.logger.info('Macro', `Macro daily saved for ${today.toISOString().split('T')[0]}`);
        logger_1.logger.info('Macro', `Fear/Greed: ${doc.fear_greed.value} (${doc.fear_greed.classification})`);
        logger_1.logger.info('Macro', `BTC ETF flows: ${formatUsd(doc.btc_etf.total_flow_usd)}`);
        logger_1.logger.info('Macro', `Coinbase premium BTC: ${premium.btc}, ETH: ${premium.eth}`);
    }
    catch (err) {
        logger_1.logger.error('Macro', `Failed to build macro daily: ${err.message}`);
    }
}
function buildEtfFlows(flowsData, netAssetsData) {
    if (!flowsData) {
        return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] };
    }
    // Data is typically an array; take the latest entry
    const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;
    const totalFlow = latest?.totalNetFlow ?? latest?.netFlow ?? latest?.total ?? null;
    const netAssets = netAssetsData?.totalNetAssets ?? netAssetsData?.netAssets ?? null;
    const flowsByTicker = [];
    const details = latest?.flowDetails ?? latest?.details ?? latest?.etfList ?? [];
    if (Array.isArray(details)) {
        for (const item of details) {
            const ticker = item.ticker ?? item.symbol ?? item.name ?? '';
            const flow = item.netFlow ?? item.flow ?? item.value ?? 0;
            if (ticker)
                flowsByTicker.push({ ticker, flow_usd: flow });
        }
    }
    return {
        total_flow_usd: totalFlow,
        net_assets_usd: netAssets,
        flows_by_ticker: flowsByTicker,
    };
}
function buildFearGreed(data) {
    if (!data)
        return { value: null, classification: null };
    const latest = Array.isArray(data) ? data[0] : data;
    return {
        value: latest?.value ?? latest?.score ?? null,
        classification: latest?.valueClassification ?? latest?.classification ?? null,
    };
}
function buildStablecoinMcap(data) {
    if (!data)
        return { total_usd: null, change_24h_usd: null };
    const latest = Array.isArray(data) ? data[0] : data;
    return {
        total_usd: latest?.marketCap ?? latest?.total ?? null,
        change_24h_usd: latest?.change24h ?? latest?.changeUsd ?? null,
    };
}
function formatUsd(value) {
    if (value == null)
        return 'N/A';
    const abs = Math.abs(value);
    const sign = value >= 0 ? '+' : '-';
    if (abs >= 1e9)
        return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6)
        return `${sign}$${(abs / 1e6).toFixed(1)}M`;
    return `${sign}$${abs.toFixed(0)}`;
}
//# sourceMappingURL=macro-builder.js.map