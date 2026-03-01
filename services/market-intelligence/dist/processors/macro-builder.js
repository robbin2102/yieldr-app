"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndSaveMacroDaily = buildAndSaveMacroDaily;
const logger_1 = require("../utils/logger");
const coinglass_1 = require("../fetchers/coinglass");
const MacroDaily_1 = __importDefault(require("../models/MacroDaily"));
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
        logger_1.logger.info('Macro', `Coinbase premium BTC: ${premium.btc}`);
        logger_1.logger.info('Macro', `Stablecoin mcap: total=${doc.stablecoin_mcap.total_usd}, change24h=${doc.stablecoin_mcap.change_24h_usd}`);
    }
    catch (err) {
        logger_1.logger.error('Macro', `Failed to build macro daily: ${err.message}`);
    }
}
function buildEtfFlows(flowsData, netAssetsData) {
    if (!flowsData) {
        return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] };
    }
    // /api/etf/bitcoin/flow-history returns array of daily entries
    // Each entry: { timestamp, flow_usd, price_usd, etf_flows: [{ etf_ticker, flow_usd }] }
    const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;
    const totalFlow = latest?.flow_usd ?? null;
    // /api/etf/bitcoin/net-assets/history returns array
    // Each entry: { net_assets_usd, change_usd, timestamp, price_usd }
    let netAssets = null;
    if (netAssetsData) {
        const netLatest = Array.isArray(netAssetsData) ? netAssetsData[0] : netAssetsData;
        netAssets = netLatest?.net_assets_usd ?? null;
    }
    const flowsByTicker = [];
    const etfFlows = latest?.etf_flows ?? [];
    if (Array.isArray(etfFlows)) {
        for (const item of etfFlows) {
            const ticker = item.etf_ticker ?? item.ticker ?? '';
            const flow = item.flow_usd ?? item.flow ?? 0;
            if (ticker)
                flowsByTicker.push({ ticker, flow_usd: flow });
        }
    }
    return { total_flow_usd: totalFlow, net_assets_usd: netAssets, flows_by_ticker: flowsByTicker };
}
function classifyFearGreed(value) {
    if (value <= 24)
        return 'Extreme Fear';
    if (value <= 49)
        return 'Fear';
    if (value <= 74)
        return 'Greed';
    return 'Extreme Greed';
}
function buildFearGreed(data) {
    if (!data)
        return { value: null, classification: null };
    // /api/index/fear-greed-history returns:
    // [{ data_list: [...values], price_list: [...], time_list: [...timestamps] }]
    const entry = Array.isArray(data) ? data[0] : data;
    const values = entry?.data_list ?? [];
    const raw = values.length > 0 ? Number(values[values.length - 1]) : NaN;
    const value = Number.isFinite(raw) ? raw : null;
    return {
        value,
        classification: value != null ? classifyFearGreed(value) : null,
    };
}
function buildStablecoinMcap(data) {
    if (!data)
        return { total_usd: null, change_24h_usd: null };
    // /api/index/stableCoin-marketCap-history returns:
    // [{ data_list: [...values], price_list: [...], time_list: [...timestamps] }]
    const entry = Array.isArray(data) ? data[0] : data;
    const values = entry?.data_list ?? [];
    const last = values.length > 0 ? Number(values[values.length - 1]) : NaN;
    const prev = values.length >= 2 ? Number(values[values.length - 2]) : NaN;
    const total = Number.isFinite(last) ? last : null;
    const change = Number.isFinite(last) && Number.isFinite(prev) ? last - prev : null;
    return { total_usd: total, change_24h_usd: change };
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