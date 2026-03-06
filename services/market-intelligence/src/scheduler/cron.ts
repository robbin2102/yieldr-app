import cron from 'node-cron';
import { logger } from '../utils/logger';
import { loadTrackedCoins, refreshTrackedCoins } from '../coins/tracker';
import { fetchAllCoins } from '../fetchers/taapi';
import { fetchAggregateData, fetchPerCoinData, fetchCoinbasePremium } from '../fetchers/coinglass';
import { fetchAndStoreOhlcv } from '../fetchers/ohlcv';
import { buildAndSaveSnapshot } from '../processors/snapshot-builder';
import { buildAndSaveMacroDaily } from '../processors/macro-builder';

export let isRunning = false;

/**
 * Main hourly cycle:
 * Phase 1 — CoinGlass aggregate (5 calls, ~10s)
 * Phase 2 — TAAPI indicators for all coins (~9 min)
 * Phase 3 — CoinGlass per-coin for top 20 (~7 min)
 * Phase 4 — Build and upsert snapshots (reads OHLCV from ohlcv_15m collection)
 */
export async function runHourlyCycle(): Promise<void> {
  if (isRunning) {
    logger.warn('Cron', 'Previous cycle still running — skipping');
    return;
  }
  isRunning = true;
  const cycleStart = Date.now();
  const timestamp  = roundToHour(new Date());
  logger.info('Cron', `═══ HOURLY CYCLE START — ${timestamp.toISOString()} ═══`);

  try {
    const { all: allCoins, full: fullCoins } = await loadTrackedCoins();
    if (allCoins.length === 0) {
      logger.warn('Cron', 'No tracked coins — skipping cycle');
      return;
    }
    logger.info('Cron', `Coins: ${allCoins.length} total, ${fullCoins.length} full-tier`);

    // Phase 1: CoinGlass aggregate (all coins)
    logger.info('Cron', '─── Phase 1: CoinGlass aggregate ───');
    const aggregateMap = await fetchAggregateData(allCoins);

    // Phase 2: TAAPI indicators (all coins)
    logger.info('Cron', '─── Phase 2: TAAPI indicators ───');
    const taapiMap = await fetchAllCoins(allCoins);

    // Phase 3: CoinGlass per-coin (top 20 only)
    logger.info('Cron', '─── Phase 3: CoinGlass per-coin (top 20) ───');
    const perCoinMap = new Map<string, any>();
    for (const coin of fullCoins) {
      const data = await fetchPerCoinData(coin);
      perCoinMap.set(coin, data);
      logger.debug('Cron', `Per-coin ${coin}: ${data.errors.length} errors`);
    }

    const premium = await fetchCoinbasePremium();

    // Phase 4: Build and upsert snapshots
    // OHLCV price data is read from ohlcv_15m collection (written by ohlcv cron at :03/:18/:33/:48)
    logger.info('Cron', '─── Phase 4: Building snapshots ───');
    let saved = 0;
    let failed = 0;

    for (const coin of allCoins) {
      const taapi     = taapiMap.get(coin) ?? { indicators: {}, candlestick_patterns: [], errors: [] };
      const aggregate = aggregateMap.get(coin) ?? {
        symbol: coin, open_interest_usd: null, oi_change_24h_pct: null, price: null,
        volume_24h: null, funding_rate_current: null, liq_long_24h: null,
        liq_short_24h: null, taker_buy_vol: null, taker_sell_vol: null,
        taker_ratio: null, basis: null,
      };
      const perCoin = perCoinMap.get(coin);
      const tier    = perCoin ? 'full' : 'lite';

      try {
        await buildAndSaveSnapshot({
          symbol: coin, timestamp, tier, taapi, aggregate, perCoin,
          coinbasePremium: premium,
        });
        saved++;
      } catch (err: any) {
        logger.error('Cron', `Failed to save snapshot for ${coin}: ${err.message}`);
        failed++;
      }
    }

    const durationMs  = Date.now() - cycleStart;
    const durationMin = (durationMs / 60000).toFixed(1);
    logger.info('Cron', `═══ CYCLE COMPLETE ═══`);
    logger.info('Cron', `  Duration: ${durationMin} min | Saved: ${saved} | Failed: ${failed}`);
    logger.info('Cron', `  Coins: ${allCoins.length} total, ${fullCoins.length} full, ${allCoins.length - fullCoins.length} lite`);
    if (durationMs > 30 * 60 * 1000) {
      logger.warn('Cron', `⚠ Cycle took ${durationMin} min — exceeds 30 min warning threshold`);
    }
  } catch (err: any) {
    logger.error('Cron', `Cycle failed: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/** Start all cron jobs */
export function startCronJobs(): void {
  // Main hourly cycle — minute 0 of every hour
  cron.schedule('0 * * * *', async () => {
    await runHourlyCycle();
  });

  // OHLCV 15m cron — provides price data (open/high/low/close/volume) for snapshot builder
  cron.schedule('3,18,33,48 * * * *', async () => {
    logger.info('Cron', 'Running 15m OHLCV cycle');
    try {
      const { all } = await loadTrackedCoins();
      if (all.length > 0) await fetchAndStoreOhlcv(all);
    } catch (err: any) {
      logger.error('Cron', `OHLCV cycle failed: ${err.message}`);
    }
  });

  // Daily macro — 10:00 UTC every day
  cron.schedule('0 10 * * *', async () => {
    logger.info('Cron', 'Running daily macro fetch');
    await buildAndSaveMacroDaily();
  });

  // Weekly coin refresh — Sunday 00:00 UTC
  cron.schedule('0 0 * * 0', async () => {
    logger.info('Cron', 'Running weekly coin list refresh');
    await refreshTrackedCoins();
  });

  logger.info('Cron', 'Cron jobs started: hourly (0 * * * *), OHLCV 15m (3,18,33,48 * * * *), daily macro (0 10 * * *), weekly refresh (0 0 * * 0)');
}

function roundToHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
