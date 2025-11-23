/**
 * Avantis Pairs Fetcher
 * Fetches all trading pairs from Avantis contracts and caches in MongoDB
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import mongoose from 'mongoose';

/**
 * Avantis PairsStorage contract address on Base
 * This contract stores all trading pair information
 */
const PAIRS_STORAGE_CONTRACT = '0x0c16ff40065cc3ab4bc55b60e447504afb9c7970' as const; // Events contract

/**
 * MongoDB Schema for Avantis Pairs
 */
const AvatisPairSchema = new mongoose.Schema({
  pairIndex: { type: Number, required: true, unique: true, index: true },
  symbol: { type: String, required: true },
  baseAsset: { type: String, required: true },
  quoteAsset: { type: String, required: true },
  name: { type: String },
  isActive: { type: Boolean, default: true },
  lastUpdated: { type: Date, default: Date.now },
});

export const AvantisPair = mongoose.models.AvantisPair ||
  mongoose.model('AvantisPair', AvatisPairSchema, 'avantis_pairs');

/**
 * Pair info interface
 */
export interface PairInfo {
  pairIndex: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  name?: string;
}

/**
 * In-memory cache for pairs
 */
let pairsCache: Map<number, PairInfo> = new Map();
let lastFetchTime = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create viem client for pair fetching
 */
function createPairsClient() {
  const rpcUrl = process.env.QUICKNODE_BASE_RPC_URL;
  if (!rpcUrl) {
    throw new Error('QUICKNODE_BASE_RPC_URL not set');
  }

  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
}

/**
 * Fetch pair info from Avantis contracts
 * Note: This is a placeholder - need to find the actual contract method
 * The Python SDK uses pairs_cache.get_pairs_info() which likely calls a contract
 */
export async function fetchPairsFromContract(): Promise<PairInfo[]> {
  const client = createPairsClient();
  const pairs: PairInfo[] = [];

  try {
    console.log('[PairsFetcher] Fetching pairs from Avantis contracts...');

    // Try to fetch pairs up to index 150 (should cover all current + future pairs)
    // We'll call a view function on the contract to get pair data
    // This is similar to what the Python SDK does

    // TODO: Find the exact contract ABI and method
    // For now, we'll use a fallback of known pairs + fetch events to discover new ones

    console.log('[PairsFetcher] ⚠️  Direct contract fetching not implemented yet');
    console.log('[PairsFetcher] Using fallback: scanning events for pair indices');

    // Fetch recent MarketExecuted events to discover active pairs
    const logs = await client.getLogs({
      address: PAIRS_STORAGE_CONTRACT,
      event: parseAbiItem('event MarketExecuted(uint256 indexed orderId, tuple(address trader, uint256 pairIndex, uint256 index, bool long, bool isOpen, uint256 collateralIndex, uint8 tradeType, uint256 collateral, uint256 openPrice, uint256 tp, uint256 sl, uint256 timestamp) trade, bool open, uint64 price, uint256 priceImpactP, uint256 positionSizeUsdc, int256 percentProfit, uint256 usdcSentToTrader, uint256 collateralPriceUsd)'),
      fromBlock: 'earliest',
      toBlock: 'latest',
    });

    // Extract unique pair indices
    const pairIndices = new Set<number>();
    for (const log of logs) {
      const { args } = log as any;
      if (args?.trade?.pairIndex !== undefined) {
        pairIndices.add(Number(args.trade.pairIndex));
      }
    }

    console.log(`[PairsFetcher] Found ${pairIndices.size} unique pair indices from events`);

    // For now, return empty array since we need the contract ABI
    // The caller should use the hardcoded pairs as fallback
    return pairs;

  } catch (error) {
    console.error('[PairsFetcher] Error fetching pairs from contract:', error);
    return pairs;
  }
}

/**
 * Fetch all pairs and save to MongoDB
 */
export async function updatePairsCache(): Promise<void> {
  try {
    console.log('[PairsFetcher] Updating pairs cache...');

    // Fetch from contract
    const contractPairs = await fetchPairsFromContract();

    // If contract fetch succeeded, save to MongoDB
    if (contractPairs.length > 0) {
      for (const pair of contractPairs) {
        await AvantisPair.findOneAndUpdate(
          { pairIndex: pair.pairIndex },
          {
            ...pair,
            lastUpdated: new Date(),
          },
          { upsert: true }
        );
      }

      console.log(`[PairsFetcher] ✓ Updated ${contractPairs.length} pairs in MongoDB`);
    } else {
      console.log('[PairsFetcher] ⚠️  No pairs fetched from contract, using hardcoded fallback');

      // Use hardcoded known pairs as fallback
      const knownPairs = getKnownPairs();
      for (const pair of knownPairs) {
        await AvantisPair.findOneAndUpdate(
          { pairIndex: pair.pairIndex },
          {
            ...pair,
            lastUpdated: new Date(),
          },
          { upsert: true }
        );
      }

      console.log(`[PairsFetcher] ✓ Saved ${knownPairs.length} known pairs to MongoDB`);
    }

    // Load into memory cache
    await loadPairsFromDB();

    lastFetchTime = Date.now();

  } catch (error) {
    console.error('[PairsFetcher] Error updating pairs cache:', error);
    throw error;
  }
}

/**
 * Load pairs from MongoDB into memory
 */
export async function loadPairsFromDB(): Promise<void> {
  try {
    const pairs = await AvantisPair.find({ isActive: true }).lean();

    pairsCache.clear();
    for (const pair of pairs) {
      pairsCache.set(pair.pairIndex, {
        pairIndex: pair.pairIndex,
        symbol: pair.symbol,
        baseAsset: pair.baseAsset,
        quoteAsset: pair.quoteAsset,
        name: pair.name,
      });
    }

    console.log(`[PairsFetcher] ✓ Loaded ${pairsCache.size} pairs into memory cache`);
  } catch (error) {
    console.error('[PairsFetcher] Error loading pairs from DB:', error);

    // Fallback to hardcoded pairs
    const knownPairs = getKnownPairs();
    pairsCache.clear();
    for (const pair of knownPairs) {
      pairsCache.set(pair.pairIndex, pair);
    }

    console.log(`[PairsFetcher] ⚠️  Using ${pairsCache.size} hardcoded pairs as fallback`);
  }
}

/**
 * Get pair symbol from cache
 */
export function getPairSymbol(pairIndex: number): string {
  const pair = pairsCache.get(pairIndex);
  return pair ? pair.symbol : `UNKNOWN-${pairIndex}`;
}

/**
 * Get pair info from cache
 */
export function getPairInfo(pairIndex: number): PairInfo | undefined {
  return pairsCache.get(pairIndex);
}

/**
 * Check if cache needs refresh
 */
export function shouldRefreshCache(): boolean {
  return Date.now() - lastFetchTime > CACHE_TTL;
}

/**
 * Hardcoded known pairs (expanded list with new pairs found in your data)
 * This serves as fallback until we can fetch directly from contracts
 */
function getKnownPairs(): PairInfo[] {
  return [
    { pairIndex: 0, symbol: 'ETH/USD', baseAsset: 'ETH', quoteAsset: 'USD', name: 'Ethereum' },
    { pairIndex: 1, symbol: 'BTC/USD', baseAsset: 'BTC', quoteAsset: 'USD', name: 'Bitcoin' },
    { pairIndex: 2, symbol: 'SOL/USD', baseAsset: 'SOL', quoteAsset: 'USD', name: 'Solana' },
    { pairIndex: 3, symbol: 'LINK/USD', baseAsset: 'LINK', quoteAsset: 'USD', name: 'Chainlink' },
    { pairIndex: 4, symbol: 'ARB/USD', baseAsset: 'ARB', quoteAsset: 'USD', name: 'Arbitrum' },
    { pairIndex: 5, symbol: 'MATIC/USD', baseAsset: 'MATIC', quoteAsset: 'USD', name: 'Polygon' },
    { pairIndex: 6, symbol: 'AVAX/USD', baseAsset: 'AVAX', quoteAsset: 'USD', name: 'Avalanche' },
    { pairIndex: 7, symbol: 'ATOM/USD', baseAsset: 'ATOM', quoteAsset: 'USD', name: 'Cosmos' },
    { pairIndex: 8, symbol: 'NEAR/USD', baseAsset: 'NEAR', quoteAsset: 'USD', name: 'NEAR Protocol' },
    { pairIndex: 9, symbol: 'AAVE/USD', baseAsset: 'AAVE', quoteAsset: 'USD', name: 'Aave' },
    { pairIndex: 10, symbol: 'ADA/USD', baseAsset: 'ADA', quoteAsset: 'USD', name: 'Cardano' },
    { pairIndex: 27, symbol: 'XRP/USD', baseAsset: 'XRP', quoteAsset: 'USD', name: 'Ripple' },
    { pairIndex: 62, symbol: 'UNI/USD', baseAsset: 'UNI', quoteAsset: 'USD', name: 'Uniswap' },
    { pairIndex: 75, symbol: 'PEPE/USD', baseAsset: 'PEPE', quoteAsset: 'USD', name: 'Pepe' },
    { pairIndex: 76, symbol: 'WIF/USD', baseAsset: 'WIF', quoteAsset: 'USD', name: 'Dogwifhat' },
    { pairIndex: 92, symbol: 'BNB/USD', baseAsset: 'BNB', quoteAsset: 'USD', name: 'BNB' },
    // Add more as discovered
  ];
}

/**
 * Initialize pairs cache on service startup
 */
export async function initializePairsCache(): Promise<void> {
  console.log('[PairsFetcher] Initializing pairs cache...');

  try {
    // Try to load from MongoDB first
    await loadPairsFromDB();

    // If cache is empty or stale, update from contract
    if (pairsCache.size === 0 || shouldRefreshCache()) {
      await updatePairsCache();
    }

    console.log(`[PairsFetcher] ✓ Pairs cache initialized with ${pairsCache.size} pairs`);
  } catch (error) {
    console.error('[PairsFetcher] Error initializing pairs cache:', error);

    // Last resort: use hardcoded pairs
    const knownPairs = getKnownPairs();
    pairsCache.clear();
    for (const pair of knownPairs) {
      pairsCache.set(pair.pairIndex, pair);
    }

    console.log(`[PairsFetcher] ⚠️  Initialized with ${pairsCache.size} hardcoded pairs (fallback)`);
  }
}
