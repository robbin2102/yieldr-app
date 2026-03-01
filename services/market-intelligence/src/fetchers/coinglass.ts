import { config } from '../config';
import { logger } from '../utils/logger';
import { getCoinGlassRateLimiter } from './rate-limiter';

const BASE = config.coinglass.baseUrl;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const skipList = new Set<string>();

async function cgGet(path: string, retries = 3): Promise<any> {
  if (skipList.has(path)) return null;

  // Build headers here (not at module level) so the apiKey getter is only
  // evaluated inside a running function, after the HTTP server has started.
  const headers = {
    'CG-API-KEY': config.coinglass.apiKey,
    'Content-Type': 'application/json',
  };

  const rl = getCoinGlassRateLimiter(config.coinglass.tokensPerMinute);
  await rl.consume(1);

  const url = `${BASE}${path}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { headers });

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
      if (json.code !== '0' && json.code !== 0) {
        logger.warn('CoinGlass', `Non-zero code on ${path}: ${json.code} — ${json.msg}`);
        return null;
      }
      if (json.data == null) {
        logger.warn('CoinGlass', `Null data payload on ${path}`);
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

// ─── Phase 1: Aggregate endpoints ────────────────────────────────────────────
// Only endpoints that return ALL coins in a single call.

export interface CoinAggregateData {
  symbol: string;
  funding_rate_current: number | null;
  liq_long_24h: number | null;
  liq_short_24h: number | null;
}

export async function fetchAggregateData(trackedCoins: string[]): Promise<Map<string, CoinAggregateData>> {
  const result = new Map<string, CoinAggregateData>();

  for (const coin of trackedCoins) {
    result.set(coin, {
      symbol: coin,
      funding_rate_current: null,
      liq_long_24h: null,
      liq_short_24h: null,
    });
  }

  const trackedSet = new Set(trackedCoins.map(c => c.toUpperCase()));

  // 1. funding-rate/exchange-list → current funding rates
  // Response: [{ symbol, stablecoin_margin_list: [{ exchange, funding_rate }], token_margin_list }]
  logger.info('CoinGlass', 'Fetching funding-rate/exchange-list');
  const fundingList = await cgGet('/api/futures/funding-rate/exchange-list');
  if (fundingList && Array.isArray(fundingList)) {
    for (const item of fundingList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        // Use Binance stablecoin-margined rate as the reference funding rate
        const binanceEntry = (item.stablecoin_margin_list ?? [])
          .find((e: any) => e.exchange === 'Binance');
        const rate = binanceEntry?.funding_rate
          ?? (item.stablecoin_margin_list?.[0]?.funding_rate)
          ?? null;
        entry.funding_rate_current = rate;
      }
    }
  }

  // 2. liquidation/coin-list → 24h liquidation totals
  logger.info('CoinGlass', 'Fetching liquidation/coin-list');
  const liqList = await cgGet('/api/futures/liquidation/coin-list');
  if (liqList && Array.isArray(liqList)) {
    for (const item of liqList) {
      const sym = (item.symbol || item.coin || '').toUpperCase();
      if (!trackedSet.has(sym)) continue;
      const entry = result.get(sym);
      if (entry) {
        entry.liq_long_24h  = item.longLiquidationUsd  ?? item.buyLiqUsd  ?? null;
        entry.liq_short_24h = item.shortLiquidationUsd ?? item.sellLiqUsd ?? null;
      }
    }
  }

  logger.info('CoinGlass', `Aggregate fetch complete for ${trackedCoins.length} coins`);
  return result;
}

// ─── Phase 2: Per-coin endpoints (top 20 coins) ──────────────────────────────

export interface CoinPerCoinData {
  symbol: string;
  // Funding rate OHLC: [{ time, open, high, low, close }] — 4h candles, Binance BTCUSDT pair
  funding_rate_history: any[];
  // OI-weighted funding rate OHLC: [{ time, open, high, low, close }] — 4h candles, all exchanges
  oi_weighted_funding_history: any[];
  // OI OHLC aggregated at 4h: [{ time, open, high, low, close }] — for 4h/24h change
  oi_history: any[];
  // Long/short ratios — percent values (0–100)
  long_short_global: { long: number | null; short: number | null; ratio: number | null };
  long_short_top_accounts: { long: number | null; short: number | null; ratio: number | null };
  long_short_top_positions: { long: number | null; short: number | null; ratio: number | null };
  // Aggregated liquidation history: [{ time, aggregated_long_liquidation_usd, aggregated_short_liquidation_usd }]
  liq_history: any[];
  // Pair taker buy/sell history: [{ time, taker_buy_volume_usd, taker_sell_volume_usd }]
  taker_history: any[];
  // Futures basis close value
  basis: number | null;
  errors: string[];
}

export async function fetchPerCoinData(symbol: string): Promise<CoinPerCoinData> {
  const result: CoinPerCoinData = {
    symbol,
    funding_rate_history: [],
    oi_weighted_funding_history: [],
    oi_history: [],
    long_short_global:       { long: null, short: null, ratio: null },
    long_short_top_accounts: { long: null, short: null, ratio: null },
    long_short_top_positions: { long: null, short: null, ratio: null },
    liq_history: [],
    taker_history: [],
    basis: null,
    errors: [],
  };

  const pair = `${symbol}USDT`; // e.g. BTCUSDT — required by pair-level endpoints

  const endpoints: Array<{ path: string; handler: (data: any) => void }> = [
    // Funding rate OHLC history (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, open, high, low, close }]
    {
      path: `/api/futures/funding-rate/history?exchange=Binance&symbol=${pair}&interval=4h&limit=1`,
      handler: (d) => { result.funding_rate_history = d || []; },
    },

    // OI-weighted funding rate OHLC (coin-level, all exchanges)
    // Hobby: min interval 4h. Response: [{ time, open, high, low, close }]
    {
      path: `/api/futures/funding-rate/oi-weight-history?symbol=${symbol}&interval=4h&limit=1`,
      handler: (d) => { result.oi_weighted_funding_history = d || []; },
    },

    // Aggregated OI OHLC history at 4h (coin-level, all exchanges)
    // Hobby: min interval 4h. limit=7 → 28h, enough to compute 4h and 24h pct change.
    {
      path: `/api/futures/open-interest/aggregated-history?symbol=${symbol}&interval=4h&limit=7&unit=usd`,
      handler: (d) => { result.oi_history = d || []; },
    },

    // Global long/short account ratio (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, global_account_long_percent, global_account_short_percent, global_account_long_short_ratio }]
    {
      path: `/api/futures/global-long-short-account-ratio/history?exchange=Binance&symbol=${pair}&interval=4h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_global = {
            long:  latest.global_account_long_percent  ?? null,
            short: latest.global_account_short_percent ?? null,
            ratio: latest.global_account_long_short_ratio ?? null,
          };
        }
      },
    },

    // Top trader account long/short ratio (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, top_account_long_percent, top_account_short_percent, top_account_long_short_ratio }]
    {
      path: `/api/futures/top-long-short-account-ratio/history?exchange=Binance&symbol=${pair}&interval=4h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_top_accounts = {
            long:  latest.top_account_long_percent  ?? null,
            short: latest.top_account_short_percent ?? null,
            ratio: latest.top_account_long_short_ratio ?? null,
          };
        }
      },
    },

    // Top trader position long/short ratio (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, top_position_long_percent, top_position_short_percent, top_position_long_short_ratio }]
    {
      path: `/api/futures/top-long-short-position-ratio/history?exchange=Binance&symbol=${pair}&interval=4h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[0] : d;
        if (latest) {
          result.long_short_top_positions = {
            long:  latest.top_position_long_percent  ?? null,
            short: latest.top_position_short_percent ?? null,
            ratio: latest.top_position_long_short_ratio ?? null,
          };
        }
      },
    },

    // Aggregated liquidation history (coin-level, multi-exchange)
    // Hobby: min interval 4h. limit=6 → 24h window for h24 sum.
    {
      path: `/api/futures/liquidation/aggregated-history?exchange_list=Binance,OKX,Bybit&symbol=${symbol}&interval=4h&limit=6`,
      handler: (d) => { result.liq_history = d || []; },
    },

    // Taker buy/sell volume history (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, taker_buy_volume_usd, taker_sell_volume_usd }]
    {
      path: `/api/futures/v2/taker-buy-sell-volume/history?exchange=Binance&symbol=${pair}&interval=4h&limit=4`,
      handler: (d) => { result.taker_history = d || []; },
    },

    // Futures basis history (pair-level, Binance)
    // Hobby: min interval 4h. Response: [{ time, open_basis, close_basis, open_change, close_change }]
    {
      path: `/api/futures/basis/history?exchange=Binance&symbol=${pair}&interval=4h&limit=1`,
      handler: (d) => {
        const latest = Array.isArray(d) ? d[d.length - 1] : d;
        result.basis = latest?.close_basis ?? null;
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
// Single BTC-only endpoint. ETH not available. Hobby: min interval 4h.
// Response: [{ time, premium, premium_rate }]

export async function fetchCoinbasePremium(): Promise<{ btc: number | null; eth: number | null }> {
  const result = { btc: null as number | null, eth: null as number | null };

  const data = await cgGet('/api/coinbase-premium-index?interval=4h&limit=1');
  if (data && Array.isArray(data) && data.length > 0) {
    const latest = data[data.length - 1];
    result.btc = latest?.premium ?? null;
  } else if (data && !Array.isArray(data)) {
    result.btc = data.premium ?? null;
  }

  // ETH coinbase premium is not available as a separate endpoint — stays null
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
    cgGet('/api/etf/bitcoin/flow-history?limit=1'),
    cgGet('/api/etf/ethereum/flow-history?limit=1'),
    cgGet('/api/etf/bitcoin/net-assets/history?limit=1'),
    cgGet('/api/index/fear-greed-history'),
    cgGet('/api/index/stableCoin-marketCap-history?limit=2'),
  ]);

  return { btcEtfFlows, ethEtfFlows, btcEtfNetAssets, fearGreed, stablecoinMcap };
}
