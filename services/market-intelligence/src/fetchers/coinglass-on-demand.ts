import { config } from '../config';
import { logger } from '../utils/logger';
import { fetchPerCoinData } from './coinglass';
import MarketSnapshot from '../models/MarketSnapshot';

export async function fetchOnDemand(symbol: string): Promise<Record<string, unknown> | null> {
  const upperSym = symbol.toUpperCase();

  const existing = await (MarketSnapshot as any).findOne({ symbol: upperSym })
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

  await (MarketSnapshot as any).findOneAndUpdate(
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

  // NOTE: OI, long/short ratios, and funding rate history are now sourced from
  // the binance-fetcher service (binance_funding_1h, binance_derivatives_15m).
  // On-demand enrichment only applies liq, taker, and basis from CoinGlass.

  // Liquidation from aggregated-history (Binance + OKX + Bybit)
  if (perCoin.liq_history.length > 0) {
    const latest = perCoin.liq_history[perCoin.liq_history.length - 1];
    if (!enriched.liquidations) enriched.liquidations = {};
    enriched.liquidations.latest = {
      long_usd:  latest?.aggregated_long_liquidation_usd  ?? null,
      short_usd: latest?.aggregated_short_liquidation_usd ?? null,
      count:     null,
    };
  }

  // Taker buy/sell volume
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

  return enriched;
}
