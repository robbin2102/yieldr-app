import { logger } from '../utils/logger';
import { fetchMacroData, fetchCoinbasePremium } from '../fetchers/coinglass';
import MacroDaily from '../models/MacroDaily';

export async function buildAndSaveMacroDaily(): Promise<{ _id: string; doc: Record<string, unknown> }> {
  logger.info('Macro', 'Building daily macro snapshot');

  const { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap } = await fetchMacroData();
  const premium = await fetchCoinbasePremium();

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
      logger.warn('Macro', `BTC ETF data is stale — API returned data from ${d.toISOString().slice(0, 10)}, expected ${yesterday.toISOString().slice(0, 10)} or later`);
    } else {
      logger.info('Macro', `BTC ETF data date: ${d.toISOString().slice(0, 10)}`);
    }
  } else {
    logger.warn('Macro', 'BTC ETF data_date missing from API response — cannot verify freshness');
  }

  const doc = {
    date: today,
    btc_etf: btcEtf,
    eth_etf: ethEtf,
    coinbase_premium: { btc: premium.btc },
    fear_greed: buildFearGreed(fearGreed),
    stablecoin_mcap: buildStablecoinMcap(stablecoinMcap),
  };

  const saved = await (MacroDaily as any).findOneAndUpdate(
    { date: today },
    { $set: doc },
    { upsert: true, new: true }
  );
  const _id = String(saved._id);

  logger.debug('Macro', `Macro daily saved _id=${_id}`);

  return { _id, doc: doc as unknown as Record<string, unknown> };
}

function buildEtfFlows(
  flowsData: any,
  netAssetsData: any,
): { total_flow_usd: number | null; net_assets_usd: number | null; flows_by_ticker: Array<{ ticker: string; flow_usd: number }>; data_date: Date | null } {
  if (!flowsData) {
    return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [], data_date: null };
  }

  // /api/etf/bitcoin/flow-history returns array of daily entries (descending — newest first)
  // Each entry: { timestamp, flow_usd, price_usd, etf_flows: [{ etf_ticker, flow_usd }] }
  const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;
  const totalFlow: number | null = latest?.flow_usd ?? null;

  // Parse data_date from the API entry's own timestamp so we can detect stale data.
  // CoinGlass returns timestamps in milliseconds; detect by magnitude to avoid double-converting.
  const rawTs = latest?.timestamp ?? latest?.time ?? null;
  const dataDate: Date | null = rawTs != null ? new Date(
    typeof rawTs === 'number'
      ? (rawTs > 1e12 ? rawTs : rawTs * 1000)  // already ms if > year 2001 in seconds
      : rawTs
  ) : null;

  // /api/etf/bitcoin/net-assets/history returns array (descending — newest first)
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

  return { total_flow_usd: totalFlow, net_assets_usd: netAssets, flows_by_ticker: flowsByTicker, data_date: dataDate };
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
  const raw   = values.length > 0 ? Number(values[values.length - 1]) : NaN;
  const value = Number.isFinite(raw) ? raw : null;

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

  const last  = values.length > 0 ? Number(values[values.length - 1]) : NaN;
  const prev  = values.length >= 2 ? Number(values[values.length - 2]) : NaN;

  const total  = Number.isFinite(last) ? last : null;
  const change = Number.isFinite(last) && Number.isFinite(prev) ? last - prev : null;

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
