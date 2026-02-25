import { config } from '../config';
import { logger } from '../utils/logger';
import { TrackedCoins } from '../models';

const TAAPI_EXCHANGE_SYMBOLS_URL = `${config.taapi.baseUrl}/exchange-symbols`;
const CG_COINS_MARKETS_URL = `${config.coinglass.baseUrl}/api/futures/coins-markets`;

// Stablecoins and tokens we never want to track
const EXCLUDE_SYMBOLS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'GUSD', 'FRAX',
  'WBTC', 'WETH', 'STETH', 'RETH', 'CBETH', // wrapped tokens
]);

/**
 * Refresh the dynamic tracked coins list.
 * Steps:
 * 1. TAAPI exchange-symbols → available symbols on binancefutures
 * 2. CoinGlass coins-markets → all coins with OI
 * 3. Intersect → top 100 by OI
 * 4. Save to tracked_coins collection
 */
export async function refreshTrackedCoins(): Promise<{ all: string[]; full: string[]; lite: string[] }> {
  logger.info('Tracker', 'Refreshing tracked coins list...');

  // Step 1: TAAPI symbols
  const taapiSymbols = await fetchTaapiSymbols();
  logger.info('Tracker', `TAAPI binancefutures symbols: ${taapiSymbols.size}`);

  // Step 2: CoinGlass markets
  const cgCoins = await fetchCoinGlassMarkets();
  logger.info('Tracker', `CoinGlass coins: ${cgCoins.length}`);

  // Step 3: Intersect
  const intersected = cgCoins.filter(item => {
    const sym = item.symbol.toUpperCase();
    return taapiSymbols.has(sym) && !EXCLUDE_SYMBOLS.has(sym);
  });

  const excluded = cgCoins
    .filter(item => EXCLUDE_SYMBOLS.has(item.symbol.toUpperCase()))
    .map(item => item.symbol.toUpperCase());

  // Step 4: Sort by OI descending, take top 100
  intersected.sort((a, b) => (b.openInterest ?? 0) - (a.openInterest ?? 0));

  const all = intersected.slice(0, config.totalTrackedCoins).map(item => item.symbol.toUpperCase());
  const full = all.slice(0, config.fullDerivativesTier);
  const lite = all.slice(config.fullDerivativesTier);

  // Step 5: Save to DB
  await TrackedCoins.findOneAndUpdate(
    {},
    {
      $set: {
        updated_at: new Date(),
        all,
        full_derivatives: full,
        lite_derivatives: lite,
        excluded,
        source_taapi_count: taapiSymbols.size,
        source_coinglass_count: cgCoins.length,
        intersection_count: intersected.length,
      },
    },
    { upsert: true, new: true }
  );

  logger.info('Tracker', `Tracked coins updated: ${all.length} total, ${full.length} full, ${lite.length} lite`);
  logger.info('Tracker', `Top 10: ${all.slice(0, 10).join(', ')}`);

  return { all, full, lite };
}

/**
 * Load tracked coins from DB. Falls back to refreshing if not found.
 */
export async function loadTrackedCoins(): Promise<{ all: string[]; full: string[]; lite: string[] }> {
  const stored = await TrackedCoins.findOne().sort({ updated_at: -1 });

  if (stored && stored.all.length > 0) {
    const ageMs = Date.now() - stored.updated_at.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    logger.info('Tracker', `Loaded ${stored.all.length} coins from DB (age: ${ageDays.toFixed(1)} days)`);
    return {
      all: stored.all,
      full: stored.full_derivatives,
      lite: stored.lite_derivatives,
    };
  }

  logger.info('Tracker', 'No stored coins found — refreshing now');
  return refreshTrackedCoins();
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function fetchTaapiSymbols(): Promise<Set<string>> {
  try {
    const url = `${TAAPI_EXCHANGE_SYMBOLS_URL}?secret=${config.taapi.apiKey}&exchange=${config.taapi.exchange}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TAAPI exchange-symbols ${res.status}`);
    const symbols = await res.json() as string[];

    // Convert "BTC/USDT" → "BTC"
    const baseSymbols = new Set<string>();
    for (const sym of symbols) {
      const [base] = sym.split('/');
      if (base) baseSymbols.add(base.toUpperCase());
    }
    return baseSymbols;
  } catch (err: any) {
    logger.error('Tracker', `Failed to fetch TAAPI symbols: ${err.message}`);
    return new Set();
  }
}

interface CgMarketItem {
  symbol: string;
  openInterest: number | null;
  price: number | null;
}

async function fetchCoinGlassMarkets(): Promise<CgMarketItem[]> {
  try {
    const res = await fetch(CG_COINS_MARKETS_URL, {
      headers: {
        'CG-API-KEY': config.coinglass.apiKey,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`CoinGlass coins-markets ${res.status}`);
    const json = await res.json() as any;

    if (json.code !== '0' && json.code !== 0) {
      throw new Error(`CoinGlass API error: ${json.msg}`);
    }

    const data: any[] = json.data || [];
    return data.map(item => ({
      symbol: (item.symbol || item.coin || '').toUpperCase(),
      openInterest: item.openInterest ?? item.openInterestUsd ?? null,
      price: item.price ?? item.lastPrice ?? null,
    })).filter(item => item.symbol.length > 0);
  } catch (err: any) {
    logger.error('Tracker', `Failed to fetch CoinGlass markets: ${err.message}`);
    return [];
  }
}
