/**
 * Avantis Trading Pairs Configuration
 * Maps pairIndex to trading pair symbols
 *
 * Source: https://sdk.avantisfi.com/get_information_and_parameters.html
 */

export interface TradingPair {
  symbol: string; // e.g., "ETH/USD"
  baseAsset: string; // e.g., "ETH"
  quoteAsset: string; // e.g., "USD"
  name: string; // e.g., "Ethereum"
}

/**
 * Pair Index to Symbol Mapping
 * TODO: Verify these mappings against Avantis docs/contracts
 */
export const PAIR_INDEX_MAP: Record<number, TradingPair> = {
  0: {
    symbol: 'ETH/USD',
    baseAsset: 'ETH',
    quoteAsset: 'USD',
    name: 'Ethereum',
  },
  1: {
    symbol: 'BTC/USD',
    baseAsset: 'BTC',
    quoteAsset: 'USD',
    name: 'Bitcoin',
  },
  2: {
    symbol: 'SOL/USD',
    baseAsset: 'SOL',
    quoteAsset: 'USD',
    name: 'Solana',
  },
  3: {
    symbol: 'LINK/USD',
    baseAsset: 'LINK',
    quoteAsset: 'USD',
    name: 'Chainlink',
  },
  4: {
    symbol: 'ARB/USD',
    baseAsset: 'ARB',
    quoteAsset: 'USD',
    name: 'Arbitrum',
  },
  5: {
    symbol: 'MATIC/USD',
    baseAsset: 'MATIC',
    quoteAsset: 'USD',
    name: 'Polygon',
  },
  6: {
    symbol: 'BNB/USD',
    baseAsset: 'BNB',
    quoteAsset: 'USD',
    name: 'BNB',
  },
  7: {
    symbol: 'XRP/USD',
    baseAsset: 'XRP',
    quoteAsset: 'USD',
    name: 'Ripple',
  },
  8: {
    symbol: 'ADA/USD',
    baseAsset: 'ADA',
    quoteAsset: 'USD',
    name: 'Cardano',
  },
  9: {
    symbol: 'DOGE/USD',
    baseAsset: 'DOGE',
    quoteAsset: 'USD',
    name: 'Dogecoin',
  },
  10: {
    symbol: 'AVAX/USD',
    baseAsset: 'AVAX',
    quoteAsset: 'USD',
    name: 'Avalanche',
  },
  // Add more pairs as needed
} as const;

/**
 * Get trading pair symbol from pairIndex
 * @param pairIndex - Pair index from contract
 * @returns Trading pair symbol (e.g., "ETH/USD")
 */
export function getPairSymbol(pairIndex: number): string {
  const pair = PAIR_INDEX_MAP[pairIndex];
  return pair ? pair.symbol : `UNKNOWN-${pairIndex}`;
}

/**
 * Get trading pair info from pairIndex
 * @param pairIndex - Pair index from contract
 * @returns Trading pair info or null if not found
 */
export function getPairInfo(pairIndex: number): TradingPair | null {
  return PAIR_INDEX_MAP[pairIndex] || null;
}

/**
 * Get all supported pairs
 * @returns Array of all trading pairs
 */
export function getAllPairs(): TradingPair[] {
  return Object.values(PAIR_INDEX_MAP);
}

/**
 * Check if a pairIndex is supported
 * @param pairIndex - Pair index to check
 * @returns true if supported
 */
export function isPairSupported(pairIndex: number): boolean {
  return pairIndex in PAIR_INDEX_MAP;
}
