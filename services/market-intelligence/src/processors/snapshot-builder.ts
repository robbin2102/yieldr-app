import { logger } from '../utils/logger';
import { TaapiCoinData } from '../fetchers/taapi';
import { CoinAggregateData, CoinPerCoinData } from '../fetchers/coinglass';
import MarketSnapshot from '../models/MarketSnapshot';
import LiquidationLevels from '../models/LiquidationLevels';
import { bucketLiquidations } from './liquidation-bucketer';

interface BuildSnapshotArgs {
  symbol: string;
  timestamp: Date;
  tier: 'full' | 'lite';
  taapi: TaapiCoinData;
  aggregate: CoinAggregateData;
  perCoin?: CoinPerCoinData;
  coinbasePremium?: { btc: number | null; eth: number | null };
}

export async function buildAndSaveSnapshot(args: BuildSnapshotArgs): Promise<void> {
  const { symbol, timestamp, tier, taapi, aggregate, perCoin, coinbasePremium } = args;
  const start = Date.now();

  const indicators = taapi.indicators as any;
  const closePrice: number | null = indicators?.vwap ?? indicators?.pivot_points?.pp ?? null;

  const derivatives = buildDerivatives(aggregate, perCoin, coinbasePremium, symbol);

  const snapshotDoc = {
    symbol: symbol.toUpperCase(),
    timestamp,
    interval: '1h',
    price: { open: null, high: null, low: null, close: closePrice, volume: null },
    indicators: {
      ema_8:        indicators?.ema_8        ?? null,
      ema_21:       indicators?.ema_21       ?? null,
      ema_50:       indicators?.ema_50       ?? null,
      ema_200:      indicators?.ema_200      ?? null,
      sma_50:       indicators?.sma_50       ?? null,
      sma_200:      indicators?.sma_200      ?? null,
      rsi_14:       indicators?.rsi_14       ?? null,
      macd:         indicators?.macd         ?? null,
      stoch_rsi:    indicators?.stoch_rsi    ?? null,
      adx:          indicators?.adx          ?? null,
      momentum:     indicators?.momentum     ?? null,
      bbands:       indicators?.bbands       ?? null,
      atr_14:       indicators?.atr_14       ?? null,
      squeeze:      indicators?.squeeze      ?? null,
      vwap:         indicators?.vwap         ?? null,
      obv:          indicators?.obv          ?? null,
      cmf:          indicators?.cmf          ?? null,
      ichimoku:     indicators?.ichimoku     ?? null,
      supertrend:   indicators?.supertrend   ?? null,
      psar:         indicators?.psar         ?? null,
      pivot_points: indicators?.pivot_points ?? null,
      fibonacci:    indicators?.fibonacci    ?? null,
      swing_high:   indicators?.swing_high   ?? null,
      swing_low:    indicators?.swing_low    ?? null,
    },
    candlestick_patterns: taapi.candlestick_patterns,
    derivatives,
    computed: {
      ma_crossovers: [],
      divergences: [],
      market_structure: {},
      fvg: [],
      order_blocks: [],
      alerts: [],
    },
    chart_patterns: [],
    tier,
    fetched_on_demand: false,
    on_demand_expires_at: null,
    fetch_duration_ms: Date.now() - start,
    errors: taapi.errors,
  };

  try {
    await MarketSnapshot.findOneAndUpdate(
      { symbol: snapshotDoc.symbol, timestamp },
      { $set: snapshotDoc },
      { upsert: true, new: true }
    );
    logger.debug('Snapshot', `${symbol} saved (tier=${tier})`);
  } catch (err: any) {
    logger.error('Snapshot', `${symbol} save failed: ${err.message}`);
    throw err;
  }

  if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
    await updateLiquidationLevels(symbol, perCoin.liq_history, closePrice);
  }
}

function buildDerivatives(
  aggregate: CoinAggregateData,
  perCoin: CoinPerCoinData | undefined,
  coinbasePremium: { btc: number | null; eth: number | null } | undefined,
  symbol: string,
): Record<string, unknown> {
  const sym = symbol.toUpperCase();

  const fundingCurrent = aggregate.funding_rate_current;
  const fundingAnnualized = fundingCurrent != null ? fundingCurrent * 3 * 365 * 100 : null;

  // OI from aggregated-history: [{ time, open, high, low, close }] strings
  let oiTotal: number | null = null;
  let oiChange4h: number | null = null;
  if (perCoin?.oi_history && perCoin.oi_history.length >= 1) {
    const vals = perCoin.oi_history;
    const curr = parseFloat(vals[vals.length - 1]?.close ?? '') || null;
    oiTotal = curr;
    if (vals.length >= 2) {
      const prev = parseFloat(vals[vals.length - 2]?.close ?? '') || null;
      if (curr && prev) oiChange4h = ((curr - prev) / prev) * 100;
    }
  }

  // Liquidation from aggregated-history: [{ time, aggregated_long_liquidation_usd, aggregated_short_liquidation_usd }]
  let liqH4 = { long_usd: null as number | null, short_usd: null as number | null };
  let liqLatest = { long_usd: null as number | null, short_usd: null as number | null, count: null as number | null };
  if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
    const h1Data = perCoin.liq_history[perCoin.liq_history.length - 1];
    liqLatest = {
      long_usd:  h1Data?.aggregated_long_liquidation_usd  ?? null,
      short_usd: h1Data?.aggregated_short_liquidation_usd ?? null,
      count:     null,
    };
    if (perCoin.liq_history.length >= 2) {
      const h4Long  = perCoin.liq_history.reduce((s: number, d: any) => s + (d?.aggregated_long_liquidation_usd  ?? 0), 0);
      const h4Short = perCoin.liq_history.reduce((s: number, d: any) => s + (d?.aggregated_short_liquidation_usd ?? 0), 0);
      liqH4 = { long_usd: h4Long, short_usd: h4Short };
    }
  }

  return {
    open_interest: {
      total_usd:      oiTotal,
      change_4h_pct:  oiChange4h,
      change_24h_pct: null,    // not available on Hobby plan aggregate
    },
    funding_rate: {
      current:     fundingCurrent,
      predicted:   null,
      oi_weighted: null,        // not available on Hobby plan
      vol_weighted: null,       // not available on Hobby plan
      annualized:  fundingAnnualized,
    },
    funding_arbitrage: [],      // removed: requires plan upgrade
    long_short_ratio: {
      global_accounts: perCoin?.long_short_global       ?? { long: null, short: null, ratio: null },
      top_accounts:    perCoin?.long_short_top_accounts ?? { long: null, short: null, ratio: null },
      top_positions:   perCoin?.long_short_top_positions ?? { long: null, short: null, ratio: null },
    },
    liquidations: {
      latest: liqLatest,        // most recent 4h candle
      h4:     liqH4,            // sum of available candles
      h24: {
        long_usd:  aggregate.liq_long_24h,
        short_usd: aggregate.liq_short_24h,
      },
    },
    taker_buy_sell: {
      buy_vol_usd:  perCoin?.taker_buy_vol_usd  ?? null,
      sell_vol_usd: perCoin?.taker_sell_vol_usd ?? null,
      buy_ratio:    perCoin?.taker_buy_ratio    ?? null,
      sell_ratio:   perCoin?.taker_sell_ratio   ?? null,
    },
    basis:            perCoin?.basis ?? null,
    coinbase_premium: sym === 'BTC' ? (coinbasePremium?.btc ?? null) : null,
  };
}

async function updateLiquidationLevels(
  symbol: string,
  liqHistory: any[],
  currentPrice: number | null,
): Promise<void> {
  try {
    // liqHistory uses aggregated_long_liquidation_usd / aggregated_short_liquidation_usd
    const normalised = liqHistory.map((d: any) => ({
      ...d,
      longLiquidationUsd:  d.aggregated_long_liquidation_usd  ?? 0,
      shortLiquidationUsd: d.aggregated_short_liquidation_usd ?? 0,
    }));

    const buckets = await bucketLiquidations(symbol, normalised, currentPrice);

    const totalLong  = normalised.reduce((s, d) => s + d.longLiquidationUsd,  0);
    const totalShort = normalised.reduce((s, d) => s + d.shortLiquidationUsd, 0);

    const heaviest = buckets.reduce(
      (max, b) => (b.total_usd > (max?.total_usd ?? 0) ? b : max),
      null as typeof buckets[0] | null,
    );

    let nearestDistPct: number | null = null;
    if (currentPrice && heaviest) {
      const mid = (heaviest.price_low + heaviest.price_high) / 2;
      nearestDistPct = Math.abs(mid - currentPrice) / currentPrice * 100;
    }

    await LiquidationLevels.findOneAndUpdate(
      { symbol: symbol.toUpperCase() },
      {
        $set: {
          symbol:                symbol.toUpperCase(),
          updated_at:            new Date(),
          current_price:         currentPrice,
          price_buckets:         buckets,
          total_long_liq_24h:    totalLong,
          total_short_liq_24h:   totalShort,
          heaviest_cluster:      heaviest ? {
            price_range: `${heaviest.price_low.toFixed(2)}–${heaviest.price_high.toFixed(2)}`,
            total_usd:   heaviest.total_usd,
            side:        heaviest.long_liq_usd > heaviest.short_liq_usd ? 'long' : 'short',
          } : { price_range: null, total_usd: null, side: null },
          nearest_cluster_distance_pct: nearestDistPct,
        },
      },
      { upsert: true, new: true },
    );
  } catch (err: any) {
    logger.warn('Snapshot', `${symbol} liquidation levels update failed: ${err.message}`);
  }
}
