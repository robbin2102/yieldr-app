import { config } from '../config';
import { logger } from '../utils/logger';
import { getCoinGlassRateLimiter } from './rate-limiter';

const BASE = config.coinglass.baseUrl;
const HEADERS = {
  'CG-API-KEY': config.coinglass.apiKey,
  'Content-Type': 'application/json',
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Endpoints that may return 403 on Hobby plan — skip after first failure
const skipList = new Set<string>();

async function cgGet(path: string, retries = 3): Promise<any> {
  if (skipList.has(path)) return null;

  const rl = getCoinGlassRateLimiter(config.coinglass.tokensPerMinute);
  await rl.consume(1);

  const url = `${BASE}${path}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });

      if (res.status === 403) {
        logger.warn('CoinGlass', `403 on ${path} — not on Hobby plan, skipping permanently`);
        skipList.add(path);
        return null;
      }

      if (res.status === 429) {
        const waitMs = 30000 * (attempt + 1);
        logger.warn('CoinGlass', `Rate limited on ${path}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`CoinGlass ${res.status} on ${path}: ${text.slice(0, 200)}`);
      }

      const json = await res.json() as any;
      // CoinGlass wraps responses: { code: "0", data: [...] }
      if (json.code !== '0' && json.code !== 0) {
        logger.warn('CoinGlass', `Non-zero code on ${path}: ${json.code} — ${json.msg}`);
        return null;
      }
      return json.data;
    } catch (err: any) {
      if (attempt === retries - 1) {
        logger.warn('CoinGlass', `Failed after ${retries} attempts on ${path}: ${err.message}`);
        return null;
      }
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ─── Phase 1: Aggregate endpoints (all coins in one call each) ───────────────

export interface CoinAggregateData {
  symbol: string;
  open_interest_usd: number | null;
  oi_change_24h_pct: number | null;
  price: number | null;
  volume_24h: number | null;
  funding_rate_current: number | null;
  liq_long_24h: number | null;
  liq_short_24h: number | null;
  taker_buy_vol: number | null;
  taker_sell_vol: number | null;
  taker_ratio: number | null;
  basis: number | null;
}

/**
 * Fetch all aggregate data (Phase 1).
 * Returns a map of { symbol → CoinAggregateData }.
 */
export async function fetchAggregateData(trackedCoins: string[]): Promise<Map<string, CoinAggregateData>> {
  const result = new Map<string, CoinAggregateData>();

  // Initialize with nulls for all tracked coins
  for (const coin of trackedCoins) {
    result.set(coin, {
      symbol: coin,
      open_interest_usd: null,
      oi_change_24h_pct: null,
      price: null,
      volume_24h: null,
      funding_rate_current: null,
      liq_long_24h: null,
      liq_short_24h: null,
      taker_buy_vol: null,
      taker_sell_vol: null,
      taker_ratio: null,
      basis: null,
    });
  }

  const trackedSet = new Set(trackedCoins.map(c => c.toUpperCase()));

  // 1. coins-markets → OI, volume, price
  logger.info('CoinGlass', 'Fetching coins-markets (aggregate OI)');
  const coinsMarkets = await cgGet('/api/futures/coins-markets');
  if (coinsMarkets && Array.isArray(coinsMarkets)) {
    for (const item of coinsMarkets) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        entry.open_interest_usd = item.openInterest ?? item.openInterestUsd ?? null;
        entry.oi_change_24h_pct = item.openInterestChangePercent24h ?? item.h24Change ?? null;
        entry.price = item.price ?? item.lastPrice ?? null;
        entry.volume_24h = item.volUsd24h ?? item.volume ?? null;
      }
    }
  }

  // 2. funding-rate/exchange-list → current funding rates
  logger.info('CoinGlass', 'Fetching funding-rate/exchange-list');
  const fundingList = await cgGet('/api/futures/funding-rate/exchange-list');
  if (fundingList && Array.isArray(fundingList)) {
    for (const item of fundingList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        // funding rate is often average across exchanges
        const rate = item.fundingRate ?? item.averageFundingRate ?? item.rate ?? null;
        entry.funding_rate_current = rate;
      }
    }
  }

  // 3. liquidation/coin-list → 24h liquidation data
  logger.info('CoinGlass', 'Fetching liquidation/coin-list');
  const liqList = await cgGet('/api/futures/liquidation/coin-list');
  if (liqList && Array.isArray(liqList)) {
    for (const item of liqList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        entry.liq_long_24h = item.longLiquidationUsd ?? item.buyLiqUsd ?? null;
        entry.liq_short_24h = item.shortLiquidationUsd ?? item.sellLiqUsd ?? null;
      }
    }
  }

  // 4. taker-buysell/exchange-list → taker buy/sell ratio
  logger.info('CoinGlass', 'Fetching taker-buysell/exchange-list');
  const takerList = await cgGet('/api/futures/taker-buysell/exchange-list');
  if (takerList && Array.isArray(takerList)) {
    for (const item of takerList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        entry.taker_buy_vol = item.buyVol ?? null;
        entry.taker_sell_vol = item.sellVol ?? null;
        entry.taker_ratio = item.buySellRatio ?? (entry.taker_buy_vol && entry.taker_sell_vol
          ? entry.taker_buy_vol / (entry.taker_buy_vol + entry.taker_sell_vol)
          : null);
      }
    }
  }

  // 5. basis (if available)
  logger.info('CoinGlass', 'Fetching basis data');
  const basisList = await cgGet('/api/futures/basis');
  if (basisList && Array.isArray(basisList)) {
    for (const item of basisList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        entry.basis = item.basis ?? item.basisRate ?? null;
      }
    }
  }

  logger.info('CoinGlass', `Aggregate fetch complete for ${trackedCoins.length} coins`);
  return result;
}

// ─── Phase 2: Per-coin endpoints (top 20 coins) ──────────────────────────────

export interface CoinPerCoinData {
  symbol: string;
  funding_rate_history: any[];
  funding_arbitrage: Array<{ long_exchange: string; short_exchange: string; spread: number }>;
  oi_history: any[];
  long_short_global: { long: number | null; short: number | null };
  long_short_top_accounts: { long: number | null; short: number | null };
  long_short_top_positions: { long: number | null; short: number | null };
  liq_history: any[];
  taker_history: any[];
  cvd_history: any[];
  net_flow: number | null;
  errors: string[];
}

export async function fetchPerCoinData(symbol: string): Promise<CoinPerCoinData> {
  const result: CoinPerCoinData = {
    symbol,
    funding_rate_history: [],
    funding_arbitrage: [],
    oi_history: [],
    long_short_global: { long: null, short: null },
    long_short_top_accounts: { long: null, short: null },
    long_short_top_positions: { long: null, short: null },
    liq_history: [],
    taker_history: [],
    cvd_history: [],
    net_flow: null,
    errors: [],
  };

  const endpoints: Array<{ path: string; handler: (data: any) => void }> = [
    {
      path: `/api/futures/funding-rate/ohlc-history?symbol=${symbol}&interval=1h&limit=1`,
      handler: (d) => { result.funding_rate_history = d || []; },
    },
    {
      path: `/api/futures/funding-rate/arbitrage?symbol=${symbol}`,
      handler: (d) => {
        if (d && Array.isArray(d)) {
          result.funding_arbitrage = d.map((item: any) => ({
            long_exchange: item.longExchange ?? item.exchange1 ?? '',
            short_exchange: item.shortExchange ?? item.exchange2 ?? '',
            spread: item.spread ?? item.fundingSpread ?? 0,
          }));
        }
      },
    },
    {
      path: `/api/futures/openInterest/ohlc-history?symbol=${symbol}&interval=1h&limit=4`,
      handler: (d) => { result.oi_history = d || []; },
    },
    {
      path: `/api/futures/long-short/global-account-ratio?symbol=${symbol}&interval=1h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_global = {
            long: latest.longRatio ?? latest.longAccount ?? null,
            short: latest.shortRatio ?? latest.shortAccount ?? null,
          };
        }
      },
    },
    {
      path: `/api/futures/long-short/top-account-ratio?symbol=${symbol}&interval=1h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_top_accounts = {
            long: latest.longRatio ?? latest.longAccount ?? null,
            short: latest.shortRatio ?? latest.shortAccount ?? null,
          };
        }
      },
    },
    {
      path: `/api/futures/long-short/top-position-ratio?symbol=${symbol}&interval=1h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_top_positions = {
            long: latest.longRatio ?? latest.longPosition ?? null,
            short: latest.shortRatio ?? latest.shortPosition ?? null,
          };
        }
      },
    },
    {
      path: `/api/futures/liquidation/aggregated-history?symbol=${symbol}&interval=1h&limit=4`,
      handler: (d) => { result.liq_history = d || []; },
    },
    {
      path: `/api/futures/taker-buysell/aggregated-history?symbol=${symbol}&interval=1h&limit=4`,
      handler: (d) => { result.taker_history = d || []; },
    },
    {
      path: `/api/futures/cvd/aggregated-history?symbol=${symbol}&interval=1h&limit=4`,
      handler: (d) => { result.cvd_history = d || []; },
    },
    {
      path: `/api/futures/netflow/list?symbol=${symbol}`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        result.net_flow = latest?.netFlow ?? latest?.value ?? null;
      },
    },
  ];

  for (const { path, handler } of endpoints) {
    try {
      const data = await cgGet(path);
      if (data !== null) handler(data);
    } catch (err: any) {
      result.errors.push(`${path}: ${err.message}`);
      logger.warn('CoinGlass', `Per-coin ${symbol} ${path} failed: ${err.message}`);
    }
  }

  return result;
}

// ─── Coinbase Premium ────────────────────────────────────────────────────────

export async function fetchCoinbasePremium(): Promise<{ btc: number | null; eth: number | null }> {
  const result = { btc: null as number | null, eth: null as number | null };

  const btcData = await cgGet('/api/indicator/index/premium?symbol=BTC');
  if (btcData) result.btc = btcData.premium ?? btcData.value ?? null;

  const ethData = await cgGet('/api/indicator/index/premium?symbol=ETH');
  if (ethData) result.eth = ethData.premium ?? ethData.value ?? null;

  return result;
}

// ─── Macro / Daily endpoints ─────────────────────────────────────────────────

export async function fetchMacroData(): Promise<{
  btcEtfFlows: any;
  ethEtfFlows: any;
  btcEtfNetAssets: any;
  fearGreed: any;
  stablecoinMcap: any;
}> {
  logger.info('CoinGlass', 'Fetching daily macro data');

  const [btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap] = await Promise.all([
    cgGet('/api/indicator/bitcoin-etf/flow-history?limit=1'),
    cgGet('/api/indicator/ethereum-etf/flow-history?limit=1'),
    cgGet('/api/indicator/bitcoin-etf/net-assets'),
    cgGet('/api/indicator/fear-greed-index?limit=1'),
    cgGet('/api/indicator/stablecoin-market-cap?limit=1'),
  ]);

  return { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap };
}
