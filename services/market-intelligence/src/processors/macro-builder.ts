import { logger } from '../utils/logger';
import { fetchMacroData, fetchCoinbasePremium } from '../fetchers/coinglass';
import MacroDaily from '../models/MacroDaily';

export async function buildAndSaveMacroDaily(): Promise<void> {
  logger.info('Macro', 'Building daily macro snapshot');

  try {
    const { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap } = await fetchMacroData();
    const premium = await fetchCoinbasePremium();

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

    await MacroDaily.findOneAndUpdate(
      { date: today },
      { $set: doc },
      { upsert: true, new: true }
    );

    logger.info('Macro', `Macro daily saved for ${today.toISOString().split('T')[0]}`);
    logger.info('Macro', `Fear/Greed: ${doc.fear_greed.value} (${doc.fear_greed.classification})`);
    logger.info('Macro', `BTC ETF flows: ${formatUsd(doc.btc_etf.total_flow_usd)}`);
    logger.info('Macro', `Coinbase premium BTC: ${premium.btc}`);
  } catch (err: any) {
    logger.error('Macro', `Failed to build macro daily: ${err.message}`);
  }
}

function buildEtfFlows(
  flowsData: any,
  netAssetsData: any,
): { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }> } {
  if (!flowsData) {
    return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] };
  }

  // /api/etf/bitcoin/flow-history returns array of daily entries
  // Each entry: { timestamp, flow_usd, price_usd, etf_flows: [{ etf_ticker, flow_usd }] }
  const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;
  const totalFlow: number | null = latest?.flow_usd ?? null;

  // /api/etf/bitcoin/net-assets/history returns array
  // Each entry: { net_assets_usd, change_usd, timestamp, price_usd }
  let netAssets: number | null = null;
  if (netAssetsData) {
    const netLatest = Array.isArray(netAssetsData) ? netAssetsData[0] : netAssetsData;
    netAssets = netLatest?.net_assets_usd ?? null;
  }

  const flowsByTicker: Array<{ ticker: string; flow_usd: number }> = [];
  const etfFlows = latest?.etf_flows ?? [];
  if (Array.isArray(etfFlows)) {
    for (const item of etfFlows) {
      const ticker = item.etf_ticker ?? item.ticker ?? '';
      const flow   = item.flow_usd  ?? item.flow  ?? 0;
      if (ticker) flowsByTicker.push({ ticker, flow_usd: flow });
    }
  }

  return { total_flow_usd: totalFlow, net_assets_usd: netAssets, flows_by_ticker: flowsByTicker };
}

function classifyFearGreed(value: number): string {
  if (value <= 24) return 'Extreme Fear';
  if (value <= 49) return 'Fear';
  if (value <= 74) return 'Greed';
  return 'Extreme Greed';
}

function buildFearGreed(data: any): { value: number | null; classification: string | null } {
  if (!data) return { value: null, classification: null };

  // /api/index/fear-greed-history returns:
  // [{ data_list: [...values], price_list: [...], time_list: [...timestamps] }]
  const entry = Array.isArray(data) ? data[0] : data;
  const values: number[] = entry?.data_list ?? [];
  const value = values.length > 0 ? values[values.length - 1] : null;

  return {
    value,
    classification: value != null ? classifyFearGreed(value) : null,
  };
}

function buildStablecoinMcap(data: any): { total_usd: number | null; change_24h_usd: number | null } {
  if (!data) return { total_usd: null, change_24h_usd: null };

  // /api/index/stableCoin-marketCap-history returns:
  // [{ data_list: [...values], price_list: [...], time_list: [...timestamps] }]
  const entry = Array.isArray(data) ? data[0] : data;
  const values: number[] = entry?.data_list ?? [];

  const total  = values.length > 0 ? values[values.length - 1] : null;
  const change = values.length >= 2 ? values[values.length - 1] - values[values.length - 2] : null;

  return { total_usd: total, change_24h_usd: change };
}

function formatUsd(value: number | null): string {
  if (value == null) return 'N/A';
  const abs  = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
