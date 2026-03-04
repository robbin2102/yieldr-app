import cron from 'node-cron';
import { logger } from '../utils/logger';
import { config } from '../config';
import { mongoose } from '../db';
import FundingRate1h from '../models/FundingRate1h';
import Derivatives15m from '../models/Derivatives15m';
import {
  fetchFundingRates,
  fetchOIHistory,
  fetchGlobalLSRatio,
  fetchTopAccountLSRatio,
  fetchTopPositionLSRatio,
  toPair,
  sleep,
} from '../fetchers/binance';

// ─── Coin list ────────────────────────────────────────────────────────────────

const FALLBACK_COINS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
  'UNI', 'LTC', 'BCH', 'ATOM', 'FIL', 'APT', 'ARB', 'OP', 'INJ', 'SUI',
  'TRX', 'NEAR', 'ICP', 'HBAR', 'PEPE', 'SHIB', 'WIF', 'BONK', 'TIA', 'SEI',
  'WLD', 'ORDI', 'JUP', 'ENA', 'FTM', 'RUNE', 'CRV', 'AAVE', 'LDO', 'MKR',
  'SNX', 'COMP', 'GRT', 'DYDX', 'IMX', 'APE', 'SAND', 'MANA', 'AXS', 'ENJ',
  'GMT', 'RNDR', 'FET', 'OCEAN', 'FLOW', 'QNT', 'VET', 'ALGO', 'EOS', 'ZEC',
  'DASH', 'WAVES', 'KSM', 'ONE', 'ZIL', 'IOTA', 'THETA', 'CHZ', 'BAT', 'STORJ',
  'BAND', 'ROSE', 'JASMY', 'MINA', 'ANKR', 'CELR', 'KAVA', 'TRB', 'YFI', 'SUSHI',
  'GMX', 'PENDLE', 'RPL', 'STX', 'EGLD', 'BLUR', 'CYBER', 'CFX', 'ZK', 'MANTA',
  'JTO', 'PYTH', 'W', 'STRK', 'ALT', 'DYM', 'HOOK', 'SXP', 'ACE', 'AGIX',
];

async function loadCoins(): Promise<string[]> {
  try {
    const db = mongoose.connection.db;
    if (!db) return FALLBACK_COINS;
    const stored = await db.collection('tracked_coins').findOne({}, { sort: { updated_at: -1 } });
    if (stored?.all?.length > 0) {
      logger.info('Coins', `Loaded ${stored.all.length} coins from tracked_coins collection`);
      return stored.all as string[];
    }
  } catch (err: any) {
    logger.warn('Coins', `Could not load tracked coins from DB: ${err.message}`);
  }
  logger.info('Coins', `Using fallback list of ${FALLBACK_COINS.length} coins`);
  return FALLBACK_COINS;
}

// ─── Funding Rate Cycle (1h) ──────────────────────────────────────────────────

let fundingRunning = false;

export async function runFundingRateCycle(coins?: string[]): Promise<void> {
  if (fundingRunning) {
    logger.warn('Funding', 'Previous funding cycle still running — skipping');
    return;
  }
  fundingRunning = true;
  const start = Date.now();
  const allCoins = coins ?? await loadCoins();

  logger.info('Funding', `Starting funding rate cycle for ${allCoins.length} coins`);

  let saved = 0;
  let skipped = 0;

  for (const symbol of allCoins) {
    const pair = toPair(symbol);

    try {
      // Find last stored timestamp to do incremental fetch
      const latest = await (FundingRate1h as any).findOne(
        { symbol },
        null,
        { sort: { timestamp: -1 } }
      );
      const startTime = latest ? latest.timestamp.getTime() + 1 : undefined;
      // If no data, fetch limit=1000 (covers ~333 days of 8h settlements)
      const limit = startTime ? 5 : 1000;

      const records = await fetchFundingRates(pair, startTime, limit);
      if (records.length === 0) {
        skipped++;
        await sleep(config.binance.requestDelayMs);
        continue;
      }

      const ops = records.map(r => ({
        updateOne: {
          filter:  { symbol, timestamp: r.timestamp },
          update:  { $set: { symbol, pair, ...r } },
          upsert:  true,
        },
      }));
      await (FundingRate1h as any).bulkWrite(ops, { ordered: false });
      saved += records.length;
    } catch (err: any) {
      logger.warn('Funding', `${symbol} failed: ${err.message}`);
    }

    await sleep(config.binance.requestDelayMs);
  }

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  logger.info('Funding', `Cycle complete — ${saved} records saved, ${skipped} coins skipped, ${dur}s`);
  fundingRunning = false;
}

// ─── Derivatives Cycle (15m) ──────────────────────────────────────────────────

let derivativesRunning = false;

export async function runDerivativesCycle(coins?: string[]): Promise<void> {
  if (derivativesRunning) {
    logger.warn('Deriv', 'Previous derivatives cycle still running — skipping');
    return;
  }
  derivativesRunning = true;
  const start = Date.now();
  const allCoins = coins ?? await loadCoins();

  logger.info('Deriv', `Starting derivatives cycle for ${allCoins.length} coins`);

  let saved = 0;
  let skipped = 0;

  for (const symbol of allCoins) {
    const pair = toPair(symbol);

    try {
      // Find last stored timestamp
      const latest = await (Derivatives15m as any).findOne(
        { symbol },
        null,
        { sort: { timestamp: -1 } }
      );
      const startTime = latest ? latest.timestamp.getTime() + 1 : undefined;
      // If no data, fetch limit=500 (covers ~5 days at 15m intervals)
      const limit = startTime ? 10 : 500;

      // Fetch all 4 endpoints in parallel
      const [oiRecords, globalLS, topAccountLS, topPositionLS] = await Promise.all([
        fetchOIHistory(pair, startTime, limit),
        fetchGlobalLSRatio(pair, startTime, limit),
        fetchTopAccountLSRatio(pair, startTime, limit),
        fetchTopPositionLSRatio(pair, startTime, limit),
      ]);

      if (oiRecords.length === 0) {
        skipped++;
        await sleep(config.binance.requestDelayMs);
        continue;
      }

      // Merge by timestamp — OI is the master set
      const globalMap  = new Map(globalLS.map(r  => [r.timestamp.getTime(), r]));
      const accountMap = new Map(topAccountLS.map(r => [r.timestamp.getTime(), r]));
      const positionMap = new Map(topPositionLS.map(r => [r.timestamp.getTime(), r]));

      const ops = oiRecords.map(oi => {
        const ts   = oi.timestamp.getTime();
        const glob = globalMap.get(ts);
        const acct = accountMap.get(ts);
        const pos  = positionMap.get(ts);

        return {
          updateOne: {
            filter: { symbol, timestamp: oi.timestamp },
            update: {
              $set: {
                symbol,
                pair,
                timestamp:          oi.timestamp,
                open_interest_usdt: oi.open_interest_usdt,
                long_short_global:        glob  ? { long_pct: glob.long_pct,  short_pct: glob.short_pct,  ratio: glob.ratio }  : null,
                long_short_top_accounts:  acct  ? { long_pct: acct.long_pct,  short_pct: acct.short_pct,  ratio: acct.ratio }  : null,
                long_short_top_positions: pos   ? { long_pct: pos.long_pct,   short_pct: pos.short_pct,   ratio: pos.ratio }   : null,
              },
            },
            upsert: true,
          },
        };
      });

      await (Derivatives15m as any).bulkWrite(ops, { ordered: false });
      saved += ops.length;
    } catch (err: any) {
      logger.warn('Deriv', `${symbol} failed: ${err.message}`);
    }

    await sleep(config.binance.requestDelayMs);
  }

  const dur = ((Date.now() - start) / 1000).toFixed(1);
  logger.info('Deriv', `Cycle complete — ${saved} records saved, ${skipped} coins skipped, ${dur}s`);
  derivativesRunning = false;
}

// ─── Backfill ─────────────────────────────────────────────────────────────────
// Runs once on startup if collections are empty.

export async function runBackfill(): Promise<void> {
  logger.info('Backfill', `Backfilling ${config.backfillDays} days of Binance data`);
  const coins = await loadCoins();
  const backfillMs = config.backfillDays * 24 * 60 * 60 * 1000;
  const startTime = Date.now() - backfillMs;

  let fundingSaved = 0;
  let derivSaved   = 0;

  for (const symbol of coins) {
    const pair = toPair(symbol);

    try {
      // Funding: 8h settlements. backfillDays * 3 records. Fetch in 1 call (limit 1000 max).
      const fundingLimit = config.backfillDays * 3 + 5;
      const fundingRecords = await fetchFundingRates(pair, startTime, fundingLimit);
      if (fundingRecords.length > 0) {
        const ops = fundingRecords.map(r => ({
          updateOne: {
            filter:  { symbol, timestamp: r.timestamp },
            update:  { $set: { symbol, pair, ...r } },
            upsert:  true,
          },
        }));
        await (FundingRate1h as any).bulkWrite(ops, { ordered: false });
        fundingSaved += ops.length;
      }

      await sleep(config.binance.requestDelayMs);

      // Derivatives: 15m candles. backfillDays * 96 records per endpoint.
      // Need multiple calls if backfillDays > 5 (500 limit per call).
      let derivCursor = startTime;
      let iterCount = 0;
      const maxIter = Math.ceil((config.backfillDays * 96) / 500) + 1;

      while (iterCount < maxIter) {
        const [oiRecords, globalLS, topAccountLS, topPositionLS] = await Promise.all([
          fetchOIHistory(pair, derivCursor, 500),
          fetchGlobalLSRatio(pair, derivCursor, 500),
          fetchTopAccountLSRatio(pair, derivCursor, 500),
          fetchTopPositionLSRatio(pair, derivCursor, 500),
        ]);

        if (oiRecords.length === 0) break;

        const globalMap   = new Map(globalLS.map(r   => [r.timestamp.getTime(), r]));
        const accountMap  = new Map(topAccountLS.map(r => [r.timestamp.getTime(), r]));
        const positionMap = new Map(topPositionLS.map(r => [r.timestamp.getTime(), r]));

        const ops = oiRecords.map(oi => {
          const ts   = oi.timestamp.getTime();
          const glob = globalMap.get(ts);
          const acct = accountMap.get(ts);
          const pos  = positionMap.get(ts);
          return {
            updateOne: {
              filter: { symbol, timestamp: oi.timestamp },
              update: {
                $set: {
                  symbol, pair,
                  timestamp:          oi.timestamp,
                  open_interest_usdt: oi.open_interest_usdt,
                  long_short_global:        glob  ? { long_pct: glob.long_pct,  short_pct: glob.short_pct,  ratio: glob.ratio }  : null,
                  long_short_top_accounts:  acct  ? { long_pct: acct.long_pct,  short_pct: acct.short_pct,  ratio: acct.ratio }  : null,
                  long_short_top_positions: pos   ? { long_pct: pos.long_pct,   short_pct: pos.short_pct,   ratio: pos.ratio }   : null,
                },
              },
              upsert: true,
            },
          };
        });

        await (Derivatives15m as any).bulkWrite(ops, { ordered: false });
        derivSaved += ops.length;

        if (oiRecords.length < 500) break;
        derivCursor = oiRecords[oiRecords.length - 1].timestamp.getTime() + 1;
        iterCount++;
        await sleep(config.binance.requestDelayMs * 2);
      }
    } catch (err: any) {
      logger.warn('Backfill', `${symbol} failed: ${err.message}`);
    }

    await sleep(config.binance.requestDelayMs);
  }

  logger.info('Backfill', `Complete — ${fundingSaved} funding records, ${derivSaved} derivatives records`);
}

// ─── Cron jobs ────────────────────────────────────────────────────────────────

export function startCronJobs(): void {
  // Hourly funding rate fetch — at minute 5 of every hour (5 mins after market-intelligence cycle starts)
  cron.schedule('5 * * * *', async () => {
    logger.info('Cron', 'Running hourly funding rate cycle');
    await runFundingRateCycle();
  });

  // Every 15m derivatives fetch
  cron.schedule('*/15 * * * *', async () => {
    logger.info('Cron', 'Running 15m derivatives cycle');
    await runDerivativesCycle();
  });

  logger.info('Cron', 'Cron jobs started: funding (5 * * * *), derivatives (*/15 * * * *)');
}
