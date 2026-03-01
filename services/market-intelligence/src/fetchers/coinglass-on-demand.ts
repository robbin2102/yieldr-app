import { config } from '../config';
import { logger } from '../utils/logger';
import { fetchPerCoinData } from './coinglass';
import MarketSnapshot from '../models/MarketSnapshot';

export async function fetchOnDemand(symbol: string): Promise<Record<string, unknown> | null> {
  const upperSym = symbol.toUpperCase();

  const existing = await MarketSnapshot.findOne({ symbol: upperSym })
    .sort({ timestamp: -1 })
    .select('tier on_demand_expires_at derivatives');

  if (existing) {
    const isCached =
      existing.tier === 'on_demand' &&
      existing.on_demand_expires_at &&
      existing.on_demand_expires_at > new Date();

    if (isCached) {
      logger.info('OnDemand', `${upperSym}: serving from cache (expires ${existing.on_demand_expires_at?.toISOString()})`);
      return existing.derivatives as Record<string, unknown>;
    }
  }

  logger.info('OnDemand', `${upperSym}: cache miss — fetching per-coin CoinGlass endpoints`);

  const fetchStart = Date.now();
  const perCoin = await fetchPerCoinData(upperSym);
  const fetchMs = Date.now() - fetchStart;

  logger.info('OnDemand', `${upperSym}: fetched in ${fetchMs}ms, ${perCoin.errors.length} errors`);

  if (!existing) {
    logger.warn('OnDemand', `${upperSym}: no existing snapshot to merge into`);
    return null;
  }

  const expiresAt = new Date(Date.now() + config.onDemandCacheTtlMs);
  const enrichedDerivatives = buildEnrichedDerivatives(perCoin, existing.derivatives as Record<string, unknown>);

  await MarketSnapshot.findOneAndUpdate(
    { symbol: upperSym, timestamp: (existing as any).timestamp },
    {
      $set: {
        tier: 'on_demand',
        fetched_on_demand: true,
        on_demand_expires_at: expiresAt,
        derivatives: enrichedDerivatives,
        fetch_duration_ms: (existing as any).fetch_duration_ms + fetchMs,
        ...(perCoin.errors.length > 0 ? { $push: { fetch_errors: { $each: perCoin.errors } } } : {}),
      },
    },
    { new: true },
  );

  logger.info('OnDemand', `${upperSym}: upgraded to on_demand, cached until ${expiresAt.toISOString()}`);
  return enrichedDerivatives;
}

function buildEnrichedDerivatives(
  perCoin: Awaited<ReturnType<typeof fetchPerCoinData>>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const enriched = { ...(existing || {}) } as any;

  // OI history (4h) — extract total, 4h change
  // Response fields: { time, open, high, low, close } as strings
  if (perCoin.oi_history.length >= 2) {
    const curr = parseFloat(perCoin.oi_history[perCoin.oi_history.length - 1]?.close ?? '');
    const prev = parseFloat(perCoin.oi_history[perCoin.oi_history.length - 2]?.close ?? '');
    if (!isNaN(curr) && !isNaN(prev) && prev !== 0) {
      if (!enriched.open_interest) enriched.open_interest = {};
      enriched.open_interest.total_usd     = curr;
      enriched.open_interest.change_4h_pct = ((curr - prev) / prev) * 100;
    }
  }

  // OI history (1h) — extract 1h change (Startup+ plan; empty on Hobby)
  if (perCoin.oi_history_1h.length >= 2) {
    const curr = parseFloat(perCoin.oi_history_1h[perCoin.oi_history_1h.length - 1]?.close ?? '');
    const prev = parseFloat(perCoin.oi_history_1h[perCoin.oi_history_1h.length - 2]?.close ?? '');
    if (!isNaN(curr) && !isNaN(prev) && prev !== 0) {
      if (!enriched.open_interest) enriched.open_interest = {};
      enriched.open_interest.change_1h_pct = ((curr - prev) / prev) * 100;
    }
  }

  // Long/short ratios — now includes ratio field
  enriched.long_short_ratio = {
    global_accounts: perCoin.long_short_global,
    top_accounts:    perCoin.long_short_top_accounts,
    top_positions:   perCoin.long_short_top_positions,
  };

  // Liquidation from aggregated-history
  // Response fields: aggregated_long_liquidation_usd, aggregated_short_liquidation_usd
  if (perCoin.liq_history.length > 0) {
    const latest = perCoin.liq_history[perCoin.liq_history.length - 1];
    if (!enriched.liquidations) enriched.liquidations = {};
    enriched.liquidations.latest = {
      long_usd:  latest?.aggregated_long_liquidation_usd  ?? null,
      short_usd: latest?.aggregated_short_liquidation_usd ?? null,
      count:     null,
    };
  }

  // Taker volume from v2 history (exchange-list endpoint requires plan upgrade)
  if (perCoin.taker_history.length > 0) {
    const latest = perCoin.taker_history[perCoin.taker_history.length - 1];
    if (!enriched.taker_buy_sell) enriched.taker_buy_sell = {};
    enriched.taker_buy_sell.buy_vol_usd  = parseFloat(latest?.taker_buy_volume_usd  ?? '') || null;
    enriched.taker_buy_sell.sell_vol_usd = parseFloat(latest?.taker_sell_volume_usd ?? '') || null;
  }

  // Basis
  if (perCoin.basis !== null) {
    enriched.basis = perCoin.basis;
  }

  // Funding rate from OHLC history — use close as current rate proxy
  if (perCoin.funding_rate_history.length > 0) {
    const latest = perCoin.funding_rate_history[perCoin.funding_rate_history.length - 1];
    if (!enriched.funding_rate) enriched.funding_rate = {};
    enriched.funding_rate.history_close = parseFloat(latest?.close ?? '') || null;
    enriched.funding_rate.annualized = enriched.funding_rate.current != null
      ? enriched.funding_rate.current * 3 * 365 * 100
      : null;
  }

  // OI-weighted funding rate — close of latest 4h candle from oi-weight-history
  if (perCoin.oi_weighted_funding_history.length > 0) {
    const latest = perCoin.oi_weighted_funding_history[perCoin.oi_weighted_funding_history.length - 1];
    if (!enriched.funding_rate) enriched.funding_rate = {};
    enriched.funding_rate.oi_weighted = parseFloat(latest?.close ?? '') || null;
  }

  return enriched;
}
