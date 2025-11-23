/**
 * Avantis Trading Pairs Configuration
 * Maps pairIndex to trading pair symbols
 *
 * Pairs are fetched from MongoDB (populated by scripts/fetch-avantis-pairs.py)
 * Falls back to hardcoded map if MongoDB is unavailable
 */

import mongoose from 'mongoose';

export interface TradingPair {
  symbol: string; // e.g., "ETH/USD"
  baseAsset: string; // e.g., "ETH"
  quoteAsset: string; // e.g., "USD"
  name?: string; // e.g., "Ethereum" (optional)
}

/**
 * In-memory cache for pairs
 * Populated on first use from MongoDB
 */
let pairsCacheLoaded = false;
const pairsCache = new Map<number, TradingPair>();

/**
 * Fallback pairs (hardcoded for when MongoDB is unavailable)
 */
const FALLBACK_PAIRS: Record<number, TradingPair> = {
  0: { symbol: 'ETH/USD', baseAsset: 'ETH', quoteAsset: 'USD', name: 'Ethereum' },
  1: { symbol: 'BTC/USD', baseAsset: 'BTC', quoteAsset: 'USD', name: 'Bitcoin' },
  2: { symbol: 'SOL/USD', baseAsset: 'SOL', quoteAsset: 'USD', name: 'Solana' },
  3: { symbol: 'LINK/USD', baseAsset: 'LINK', quoteAsset: 'USD', name: 'Chainlink' },
  4: { symbol: 'ARB/USD', baseAsset: 'ARB', quoteAsset: 'USD', name: 'Arbitrum' },
  5: { symbol: 'MATIC/USD', baseAsset: 'MATIC', quoteAsset: 'USD', name: 'Polygon' },
  6: { symbol: 'BNB/USD', baseAsset: 'BNB', quoteAsset: 'USD', name: 'BNB' },
  7: { symbol: 'XRP/USD', baseAsset: 'XRP', quoteAsset: 'USD', name: 'Ripple' },
  8: { symbol: 'ADA/USD', baseAsset: 'ADA', quoteAsset: 'USD', name: 'Cardano' },
  9: { symbol: 'DOGE/USD', baseAsset: 'DOGE', quoteAsset: 'USD', name: 'Dogecoin' },
  10: { symbol: 'AVAX/USD', baseAsset: 'AVAX', quoteAsset: 'USD', name: 'Avalanche' },
} as const;

/**
 * Load pairs from MongoDB into cache
 */
async function loadPairsFromMongoDB(): Promise<void> {
  if (pairsCacheLoaded) return;

  try {
    // Get the avantispairs collection
    const db = mongoose.connection.db;
    if (!db) {
      console.warn('[Pairs] MongoDB not connected, using fallback pairs');
      return;
    }

    const pairsCollection = db.collection('avantispairs');
    const pairs = await pairsCollection.find({}).toArray();

    if (pairs.length === 0) {
      console.warn('[Pairs] No pairs found in MongoDB, using fallback pairs');
      console.warn('[Pairs] Run: python scripts/fetch-avantis-pairs.py to populate pairs');
      return;
    }

    // Populate cache
    for (const pair of pairs) {
      pairsCache.set(pair.pairIndex, {
        symbol: pair.symbol,
        baseAsset: pair.from,
        quoteAsset: pair.to,
        name: pair.from,
      });
    }

    pairsCacheLoaded = true;
    console.log(`[Pairs] ✓ Loaded ${pairs.length} pairs from MongoDB`);
  } catch (error) {
    console.error('[Pairs] Error loading pairs from MongoDB:', error);
    console.warn('[Pairs] Using fallback pairs');
  }
}

/**
 * Get trading pair symbol from pairIndex
 * @param pairIndex - Pair index from contract
 * @returns Trading pair symbol (e.g., "ETH/USD")
 */
export function getPairSymbol(pairIndex: number): string {
  // Try cache first
  const cached = pairsCache.get(pairIndex);
  if (cached) {
    return cached.symbol;
  }

  // Try fallback
  const fallback = FALLBACK_PAIRS[pairIndex];
  if (fallback) {
    return fallback.symbol;
  }

  // Return unknown
  return `UNKNOWN-${pairIndex}`;
}

/**
 * Get trading pair info from pairIndex
 * @param pairIndex - Pair index from contract
 * @returns Trading pair info or null if not found
 */
export function getPairInfo(pairIndex: number): TradingPair | null {
  const cached = pairsCache.get(pairIndex);
  if (cached) return cached;

  const fallback = FALLBACK_PAIRS[pairIndex];
  return fallback || null;
}

/**
 * Get all supported pairs
 * @returns Array of all trading pairs
 */
export function getAllPairs(): TradingPair[] {
  if (pairsCacheLoaded && pairsCache.size > 0) {
    return Array.from(pairsCache.values());
  }
  return Object.values(FALLBACK_PAIRS);
}

/**
 * Check if a pairIndex is supported
 * @param pairIndex - Pair index to check
 * @returns true if supported
 */
export function isPairSupported(pairIndex: number): boolean {
  if (pairsCache.has(pairIndex)) return true;
  return pairIndex in FALLBACK_PAIRS;
}

/**
 * Initialize pairs cache
 * Should be called once at startup after MongoDB connection
 */
export async function initializePairsCache(): Promise<void> {
  await loadPairsFromMongoDB();
}

/**
 * Refresh pairs cache from MongoDB
 * Can be called periodically to update pairs
 */
export async function refreshPairsCache(): Promise<void> {
  pairsCacheLoaded = false;
  pairsCache.clear();
  await loadPairsFromMongoDB();
}
