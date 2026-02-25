import { logger } from '../utils/logger';
import { fetchMacroData, fetchCoinbasePremium } from '../fetchers/coinglass';
import MacroDaily from '../models/MacroDaily';

/**
 * Fetch all daily macro data from CoinGlass and upsert to macro_daily collection.
 */
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
    logger.info('Macro', `Coinbase premium BTC: ${premium.btc}, ETH: ${premium.eth}`);
  } catch (err: any) {
    logger.error('Macro', `Failed to build macro daily: ${err.message}`);
  }
}

function buildEtfFlows(flowsData: any, netAssetsData: any): {
  total_flow_usd: number | null;
  net_assets_usd: number | null;
  flows_by_ticker: Array<{ ticker: string; flow_usd: number }>;
} {
  if (!flowsData) {
    return { total_flow_usd: null, net_assets_usd: null, flows_by_ticker: [] };
  }

  // Data is typically an array; take the latest entry
  const latest = Array.isArray(flowsData) ? flowsData[0] : flowsData;

  const totalFlow = latest?.totalNetFlow ?? latest?.netFlow ?? latest?.total ?? null;
  const netAssets = netAssetsData?.totalNetAssets ?? netAssetsData?.netAssets ?? null;

  const flowsByTicker: Array<{ ticker: string; flow_usd: number }> = [];
  const details = latest?.flowDetails ?? latest?.details ?? latest?.etfList ?? [];
  if (Array.isArray(details)) {
    for (const item of details) {
      const ticker = item.ticker ?? item.symbol ?? item.name ?? '';
      const flow = item.netFlow ?? item.flow ?? item.value ?? 0;
      if (ticker) flowsByTicker.push({ ticker, flow_usd: flow });
    }
  }

  return {
    total_flow_usd: totalFlow,
    net_assets_usd: netAssets,
    flows_by_ticker: flowsByTicker,
  };
}

function buildFearGreed(data: any): { value: number | null; classification: string | null } {
  if (!data) return { value: null, classification: null };
  const latest = Array.isArray(data) ? data[0] : data;
  return {
    value: latest?.value ?? latest?.score ?? null,
    classification: latest?.valueClassification ?? latest?.classification ?? null,
  };
}

function buildStablecoinMcap(data: any): { total_usd: number | null; change_24h_usd: number | null } {
  if (!data) return { total_usd: null, change_24h_usd: null };
  const latest = Array.isArray(data) ? data[0] : data;
  return {
    total_usd: latest?.marketCap ?? latest?.total ?? null,
    change_24h_usd: latest?.change24h ?? latest?.changeUsd ?? null,
  };
}

function formatUsd(value: number | null): string {
  if (value == null) return 'N/A';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '-';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  return `${sign}$${abs.toFixed(0)}`;
}
