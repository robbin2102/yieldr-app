import { logger } from '../utils/logger';
import { TaapiCoinData } from '../fetchers/taapi';
import { CoinAggregateData, CoinPerCoinData } from '../fetchers/coinglass';
import { BinanceCandleData } from '../fetchers/binance';
import { getLatestBinanceFunding, getLatestBinanceDerivatives } from '../fetchers/binance-db';
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
  binance?: BinanceCandleData;
}

export async function buildAndSaveSnapshot(args: BuildSnapshotArgs): Promise<{ _id: string; snapshot: Record<string, unknown> }> {
  const { symbol, timestamp, tier, taapi, aggregate, perCoin, coinbasePremium, binance } = args;
  const start = Date.now();

  // Load Binance derivatives data (written by binance-fetcher service, Singapore)
  // These replace the CoinGlass per-coin endpoints for funding rate, OI, and L/S ratios.
  const [binanceFunding, binanceDerivatives] = await Promise.all([
    getLatestBinanceFunding(symbol),
    getLatestBinanceDerivatives(symbol),
  ]);

  const indicators = taapi.indicators as any;

  // Price: Binance OHLCV only — no fallback to VWAP (that would corrupt computed fields)
  const closePrice: number | null = binance?.close ?? null;

  const price = {
    open:   binance?.open   ?? null,
    high:   binance?.high   ?? null,
    low:    binance?.low    ?? null,
    close:  closePrice,
    volume: binance?.volume ?? null,
  };

  // Pivot points: prefer TAAPI result, fall back to computing from Binance daily candle
  const pivotPoints = computePivotPoints(indicators?.pivot_points, binance);

  const derivatives = buildDerivatives(aggregate, perCoin, coinbasePremium, symbol, binanceFunding, binanceDerivatives);

  const indicatorsDoc = {
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
    pivot_points: pivotPoints,
    fibonacci:    indicators?.fibonacci    ?? null,
    swing_high:   indicators?.swing_high   ?? null,
    swing_low:    indicators?.swing_low    ?? null,
  };

  const computed = computeSnapshotFields(indicatorsDoc, derivatives, closePrice);

  const snapshotDoc = {
    symbol: symbol.toUpperCase(),
    timestamp,
    interval: '1h',
    price,
    indicators: indicatorsDoc,
    candlestick_patterns: taapi.candlestick_patterns,
    derivatives,
    computed,
    chart_patterns: [],
    tier,
    fetched_on_demand: false,
    on_demand_expires_at: null,
    fetch_duration_ms: Date.now() - start,
    fetch_errors: taapi.errors,
  };

  let savedId: string;
  try {
    const saved = await (MarketSnapshot as any).findOneAndUpdate(
      { symbol: snapshotDoc.symbol, timestamp },
      { $set: snapshotDoc },
      { upsert: true, new: true }
    );
    savedId = String(saved._id);
    logger.debug('Snapshot', `${symbol} saved (tier=${tier}) _id=${savedId}`);
  } catch (err: any) {
    logger.error('Snapshot', `${symbol} save failed: ${err.message}`);
    throw err;
  }

  if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
    await updateLiquidationLevels(symbol, perCoin.liq_history, closePrice ?? (indicators?.vwap as number | null) ?? null);
  }

  return { _id: savedId, snapshot: snapshotDoc as unknown as Record<string, unknown> };
}

// ─── Pivot Points ──────────────────────────────────────────────────────────────

/**
 * Returns TAAPI pivot points if populated, otherwise computes classic floor-trader
 * pivots from the previous day's Binance OHLC.
 *  PP = (H+L+C)/3
 *  R1 = 2*PP-L,  R2 = PP+(H-L),  R3 = H+2*(PP-L)
 *  S1 = 2*PP-H,  S2 = PP-(H-L),  S3 = L-2*(H-PP)
 */
function computePivotPoints(
  taapiPivots: any,
  binance: BinanceCandleData | undefined,
): Record<string, number | null> {
  // Use TAAPI if it returned real values
  if (taapiPivots?.pp != null) return taapiPivots;

  // Fall back to Binance daily OHLC
  const H = binance?.daily_high  ?? null;
  const L = binance?.daily_low   ?? null;
  const C = binance?.daily_close ?? null;

  if (H == null || L == null || C == null) {
    return { pp: null, r1: null, r2: null, r3: null, s1: null, s2: null, s3: null };
  }

  const pp = (H + L + C) / 3;
  return {
    pp,
    r1: 2 * pp - L,
    r2: pp + (H - L),
    r3: H + 2 * (pp - L),
    s1: 2 * pp - H,
    s2: pp - (H - L),
    s3: L - 2 * (H - pp),
  };
}

// ─── Derivatives ──────────────────────────────────────────────────────────────

function buildDerivatives(
  aggregate: CoinAggregateData,
  perCoin: CoinPerCoinData | undefined,
  coinbasePremium: { btc: number | null; eth: number | null } | undefined,
  symbol: string,
  binanceFunding: Awaited<ReturnType<typeof getLatestBinanceFunding>>,
  binanceDerivatives: Awaited<ReturnType<typeof getLatestBinanceDerivatives>>,
): Record<string, unknown> {
  const sym = symbol.toUpperCase();

  // Funding rate: Binance (1h granularity) preferred; fallback to CoinGlass aggregate
  const fundingCurrent   = binanceFunding?.funding_rate   ?? aggregate.funding_rate_current;
  const fundingAnnualized = binanceFunding?.annualized_rate
    ?? (fundingCurrent != null ? fundingCurrent * 3 * 365 * 100 : null);

  // OI: from Binance 15m collection (all 100 coins, with 4h/24h change pre-computed)
  const oiTotal     = binanceDerivatives?.oi.total_usdt     ?? null;
  const oiChange4h  = binanceDerivatives?.oi.change_4h_pct  ?? null;
  const oiChange24h = binanceDerivatives?.oi.change_24h_pct ?? null;

  // L/S ratios: from Binance 15m collection (all 100 coins)
  const null3 = { long: null, short: null, ratio: null };
  const lsGlobal   = binanceDerivatives?.long_short_global        ?? null3;
  const lsTopAcct  = binanceDerivatives?.long_short_top_accounts  ?? null3;
  const lsTopPos   = binanceDerivatives?.long_short_top_positions ?? null3;

  // Liquidations: still from CoinGlass (multi-exchange: Binance + OKX + Bybit)
  let liqH4  = { long_usd: null as number | null, short_usd: null as number | null };
  let liqH24 = { long_usd: null as number | null, short_usd: null as number | null };
  let liqLatest = { long_usd: null as number | null, short_usd: null as number | null, count: null as number | null };

  if (perCoin?.liq_history && perCoin.liq_history.length > 0) {
    const hist = perCoin.liq_history;
    const latest = hist[hist.length - 1];

    liqLatest = {
      long_usd:  latest?.aggregated_long_liquidation_usd  ?? null,
      short_usd: latest?.aggregated_short_liquidation_usd ?? null,
      count:     null,
    };

    liqH4 = {
      long_usd:  hist.slice(-1).reduce((s: number, d: any) => s + (d?.aggregated_long_liquidation_usd  ?? 0), 0) || null,
      short_usd: hist.slice(-1).reduce((s: number, d: any) => s + (d?.aggregated_short_liquidation_usd ?? 0), 0) || null,
    };

    const h24Long  = hist.reduce((s: number, d: any) => s + (d?.aggregated_long_liquidation_usd  ?? 0), 0);
    const h24Short = hist.reduce((s: number, d: any) => s + (d?.aggregated_short_liquidation_usd ?? 0), 0);
    liqH24 = {
      long_usd:  h24Long  || aggregate.liq_long_24h  || null,
      short_usd: h24Short || aggregate.liq_short_24h || null,
    };
  } else {
    liqH24 = { long_usd: aggregate.liq_long_24h, short_usd: aggregate.liq_short_24h };
  }

  return {
    open_interest: {
      total_usd:      oiTotal,
      change_4h_pct:  oiChange4h,
      change_24h_pct: oiChange24h,
    },
    funding_rate: {
      current:      fundingCurrent,
      predicted:    null,
      oi_weighted:  null,   // removed: was from Hobby-locked CoinGlass endpoint
      vol_weighted: null,
      annualized:   fundingAnnualized,
    },
    funding_arbitrage: [],
    long_short_ratio: {
      global_accounts: lsGlobal,
      top_accounts:    lsTopAcct,
      top_positions:   lsTopPos,
    },
    liquidations: {
      latest: liqLatest,
      h4:     liqH4,
      h24:    liqH24,
    },
    taker_buy_sell: (() => {
      const th = perCoin?.taker_history ?? [];
      const takerLatest = th[th.length - 1];
      const buyVol  = parseFloat(takerLatest?.taker_buy_volume_usd  ?? '') || null;
      const sellVol = parseFloat(takerLatest?.taker_sell_volume_usd ?? '') || null;
      const total   = buyVol != null && sellVol != null ? buyVol + sellVol : null;
      return {
        buy_vol_usd:  buyVol,
        sell_vol_usd: sellVol,
        buy_ratio:    total ? buyVol! / total : null,
        sell_ratio:   total ? sellVol! / total : null,
      };
    })(),
    basis:            perCoin?.basis ?? null,
    coinbase_premium: sym === 'BTC' ? (coinbasePremium?.btc ?? null) : null,
  };
}

// ─── Computed Fields ───────────────────────────────────────────────────────────

/**
 * Derives market_structure, ma_crossovers, and alerts from current snapshot data.
 * Note: divergences, fvg, order_blocks require multi-candle history (future work).
 */
function computeSnapshotFields(
  indicators: any,
  derivatives: any,
  closePrice: number | null,
): {
  ma_crossovers:   unknown[];
  divergences:     unknown[];
  market_structure: Record<string, unknown>;
  fvg:             unknown[];
  order_blocks:    unknown[];
  alerts:          unknown[];
} {
  const ema8   = indicators?.ema_8   ?? null;
  const ema21  = indicators?.ema_21  ?? null;
  const ema50  = indicators?.ema_50  ?? null;
  const ema200 = indicators?.ema_200 ?? null;
  const rsi    = indicators?.rsi_14  ?? null;
  const adx    = indicators?.adx?.adx ?? null;
  const supertrend = indicators?.supertrend ?? null;
  const vwap   = indicators?.vwap    ?? null;
  const macd   = indicators?.macd    ?? null;
  const funding = (derivatives as any)?.funding_rate?.current ?? null;
  const ichimoku = indicators?.ichimoku ?? null;

  // ── MA crossovers (current alignment state) ──
  const ma_crossovers: unknown[] = [];
  if (ema8 != null && ema21 != null) {
    ma_crossovers.push({ fast: 'ema_8', slow: 'ema_21', state: ema8 > ema21 ? 'above' : 'below', fast_value: ema8, slow_value: ema21 });
  }
  if (ema21 != null && ema50 != null) {
    ma_crossovers.push({ fast: 'ema_21', slow: 'ema_50', state: ema21 > ema50 ? 'above' : 'below', fast_value: ema21, slow_value: ema50 });
  }
  if (ema50 != null && ema200 != null) {
    ma_crossovers.push({ fast: 'ema_50', slow: 'ema_200', state: ema50 > ema200 ? 'above' : 'below', fast_value: ema50, slow_value: ema200 });
  }
  if (closePrice != null && ema200 != null) {
    ma_crossovers.push({ fast: 'price', slow: 'ema_200', state: closePrice > ema200 ? 'above' : 'below', fast_value: closePrice, slow_value: ema200 });
  }
  if (closePrice != null && vwap != null) {
    ma_crossovers.push({ fast: 'price', slow: 'vwap', state: closePrice > vwap ? 'above' : 'below', fast_value: closePrice, slow_value: vwap });
  }

  // ── Market structure ──
  let trend = 'neutral';
  let ema_alignment: string | null = null;

  if (ema8 != null && ema21 != null && ema50 != null && ema200 != null) {
    const bull_stack = ema8 > ema21 && ema21 > ema50 && ema50 > ema200;
    const bear_stack = ema8 < ema21 && ema21 < ema50 && ema50 < ema200;
    ema_alignment = bull_stack ? 'bullish' : bear_stack ? 'bearish' : 'mixed';

    if (bull_stack) trend = 'strong_uptrend';
    else if (bear_stack) trend = 'strong_downtrend';
    else if (ema8 > ema21 && ema21 > ema50) trend = 'uptrend';
    else if (ema8 < ema21 && ema21 < ema50) trend = 'downtrend';
  }

  // Ichimoku cloud position: above / inside / below current cloud (currentSpanA & currentSpanB)
  let ichimoku_cloud_bias: string | null = null;
  if (closePrice != null && ichimoku?.current_span_a != null && ichimoku?.current_span_b != null) {
    const cloudTop    = Math.max(ichimoku.current_span_a, ichimoku.current_span_b);
    const cloudBottom = Math.min(ichimoku.current_span_a, ichimoku.current_span_b);
    ichimoku_cloud_bias = closePrice > cloudTop ? 'above' : closePrice < cloudBottom ? 'below' : 'inside';
  }

  // Tenkan vs Kijun cross direction (tk_cross)
  let tk_cross: string | null = null;
  if (ichimoku?.tenkan != null && ichimoku?.kijun != null) {
    tk_cross = ichimoku.tenkan > ichimoku.kijun ? 'bullish' : 'bearish';
  }

  const market_structure: Record<string, unknown> = {
    trend,
    ema_alignment,
    supertrend_direction: supertrend?.direction ?? null,
    rsi_zone: rsi != null ? (rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral') : null,
    price_vs_vwap: closePrice != null && vwap != null ? (closePrice > vwap ? 'above' : 'below') : null,
    macd_bias: macd?.histogram != null ? (macd.histogram > 0 ? 'bullish' : 'bearish') : null,
    funding_bias: funding != null ? (funding > 0.01 ? 'positive' : funding < -0.01 ? 'negative' : 'neutral') : null,
    ichimoku_cloud_bias,
    ichimoku_tk_cross: tk_cross,
  };

  // ── Alerts ──
  const alerts: unknown[] = [];

  if (rsi != null) {
    if (rsi <= 20)      alerts.push({ type: 'rsi_oversold',   severity: 'high',   message: `RSI extremely oversold at ${rsi.toFixed(1)}`,   data: { rsi }, timestamp: new Date() });
    else if (rsi <= 30) alerts.push({ type: 'rsi_oversold',   severity: 'medium', message: `RSI oversold at ${rsi.toFixed(1)}`,              data: { rsi }, timestamp: new Date() });
    else if (rsi >= 80) alerts.push({ type: 'rsi_overbought', severity: 'high',   message: `RSI extremely overbought at ${rsi.toFixed(1)}`,  data: { rsi }, timestamp: new Date() });
    else if (rsi >= 70) alerts.push({ type: 'rsi_overbought', severity: 'medium', message: `RSI overbought at ${rsi.toFixed(1)}`,            data: { rsi }, timestamp: new Date() });
  }

  if (adx != null && adx >= 40) {
    alerts.push({ type: 'strong_trend', severity: 'medium', message: `Strong trend: ADX=${adx.toFixed(1)}`, data: { adx }, timestamp: new Date() });
  }

  if (funding != null) {
    const fundingPct = (funding * 100).toFixed(4);
    if (funding <= -0.05)     alerts.push({ type: 'funding_extreme_negative', severity: 'high',   message: `Extreme negative funding: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
    else if (funding <= -0.02) alerts.push({ type: 'funding_negative',        severity: 'medium', message: `Negative funding rate: ${fundingPct}%`,    data: { funding }, timestamp: new Date() });
    else if (funding >= 0.1)   alerts.push({ type: 'funding_extreme_positive', severity: 'high',  message: `Extreme positive funding: ${fundingPct}%`, data: { funding }, timestamp: new Date() });
    else if (funding >= 0.05)  alerts.push({ type: 'funding_positive',         severity: 'medium', message: `High positive funding: ${fundingPct}%`,  data: { funding }, timestamp: new Date() });
  }

  if (supertrend?.direction === 'short' && ema_alignment === 'bearish') {
    alerts.push({ type: 'bearish_confluence', severity: 'high', message: 'Supertrend + EMA alignment both bearish', data: { supertrend_dir: 'short', ema_alignment }, timestamp: new Date() });
  }
  if (supertrend?.direction === 'long' && ema_alignment === 'bullish') {
    alerts.push({ type: 'bullish_confluence', severity: 'medium', message: 'Supertrend + EMA alignment both bullish', data: { supertrend_dir: 'long', ema_alignment }, timestamp: new Date() });
  }

  if (ichimoku_cloud_bias === 'inside') {
    alerts.push({ type: 'ichimoku_in_cloud', severity: 'medium', message: 'Price inside Ichimoku cloud — consolidation / indecision zone', data: { current_span_a: ichimoku?.current_span_a, current_span_b: ichimoku?.current_span_b }, timestamp: new Date() });
  }
  if (ichimoku_cloud_bias != null && tk_cross != null && supertrend?.direction != null) {
    const allBullish = ichimoku_cloud_bias === 'above' && tk_cross === 'bullish' && supertrend.direction === 'long';
    const allBearish = ichimoku_cloud_bias === 'below' && tk_cross === 'bearish' && supertrend.direction === 'short';
    if (allBullish) alerts.push({ type: 'ichimoku_bullish_confluence', severity: 'high', message: 'Strong bullish: price above cloud, TK cross bullish, Supertrend long', data: { ichimoku_cloud_bias, tk_cross }, timestamp: new Date() });
    if (allBearish) alerts.push({ type: 'ichimoku_bearish_confluence', severity: 'high', message: 'Strong bearish: price below cloud, TK cross bearish, Supertrend short', data: { ichimoku_cloud_bias, tk_cross }, timestamp: new Date() });
  }

  return {
    ma_crossovers,
    divergences:     [],   // requires multi-candle history
    market_structure,
    fvg:             [],   // requires multi-candle history
    order_blocks:    [],   // requires multi-candle history
    alerts,
  };
}

// ─── Liquidation Levels ────────────────────────────────────────────────────────

async function updateLiquidationLevels(
  symbol: string,
  liqHistory: any[],
  currentPrice: number | null,
): Promise<void> {
  try {
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

    await (LiquidationLevels as any).findOneAndUpdate(
      { symbol: symbol.toUpperCase() },
      {
        $set: {
          symbol:               symbol.toUpperCase(),
          updated_at:           new Date(),
          current_price:        currentPrice,
          price_buckets:        buckets,
          total_long_liq_24h:   totalLong,
          total_short_liq_24h:  totalShort,
          heaviest_cluster: heaviest ? {
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
