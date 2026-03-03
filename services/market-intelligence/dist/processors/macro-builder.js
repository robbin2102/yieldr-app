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
    const { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap } = await (0, coinglass_1.fetchMacroData)();
    const premium = await (0, coinglass_1.fetchCoinbasePremium)();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const btcEtf = buildEtfFlows(btcEtfFlows, btcEtfNetAssets);
    const ethEtf = buildEtfFlows(ethEtfFlows, null);
    // Warn if ETF data is stale (data_date hasn't changed from what was previously fetched)
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    if (btcEtf.data_date) {
        const d = new Date(btcEtf.data_date);
        d.setUTCHours(0, 0, 0, 0);
        if (d < yesterday) {
            logger_1.logger.warn('Macro', `BTC ETF data is stale — API returned data from ${d.toISOString().slice(0, 10)}, expected ${yesterday.toISOString().slice(0, 10)} or later`);
        }
        else {
            logger_1.logger.info('Macro', `BTC ETF data date: ${d.toISOString().slice(0, 10)}`);
        }
    }
    else {
        logger_1.logger.warn('Macro', 'BTC ETF data_date missing from API response — cannot verify freshness');
    }
    const doc = {
        date: today,
        btc_etf: btcEtf,
        eth_etf: ethEtf,
        coinbase_premium: { btc: premium.btc },
        fear_greed: buildFearGreed(fearGreed),
        stablecoin_mcap: buildStablecoinMcap(stablecoinMcap),
    };
    const saved = await MacroDaily_1.default.findOneAndUpdate({ date: today }, { $set: doc }, { upsert: true, new: true });
    const _id = String(saved._id);
    logger_1.logger.debug('Macro', `Macro daily saved _id=${_id}`);
    return { _id, doc: doc };
}
function buildEtfFlows(flowsData, netAssetsData) {
    if (!flowsData) {
        return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [], data_date: null };
    }
    // /api/etf/bitcoin/flow-history returns array of daily entries (descending — newest first)
    // Each entry: { timestamp, flow_usd, price_usd, etf_flows: [{ etf_ticker, flow_usd }] }
    const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;
    const totalFlow = latest?.flow_usd ?? null;
    // Parse data_date from the API entry's own timestamp so we can detect stale data
    const rawTs = latest?.timestamp ?? latest?.time ?? null;
    const dataDate = rawTs != null ? new Date(typeof rawTs === 'number' ? rawTs * 1000 : rawTs) : null;
    // /api/etf/bitcoin/net-assets/history returns array (descending — newest first)
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
    return { total_flow_usd: totalFlow, net_assets_usd: netAssets, flows_by_ticker: flowsByTicker, data_date: dataDate };
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