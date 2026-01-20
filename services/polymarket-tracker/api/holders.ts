/**
 * Polymarket Holders API Client
 * Fetches top holders for markets from Data API
 */

import axios from 'axios';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/pagination';

const logger = createLogger('Holders API');

/**
 * Holder response from Data API
 */
export interface HolderResponse {
  proxyWallet: string;
  bio?: string;
  asset?: string;
  pseudonym?: string;
  amount: number;
  displayUsernamePublic?: boolean;
  outcomeIndex?: number;
  name?: string;
  profileImage?: string;
  profileImageOptimized?: string;
}

/**
 * Token holders response from Data API
 */
export interface TokenHoldersResponse {
  token: string;
  holders: HolderResponse[];
}

/**
 * Build URL for Data API
 */
function buildDataApiUrl(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(`${CONFIG.API_BASE}${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  });

  return url.toString();
}

/**
 * Fetch top holders for a market
 * @param conditionId - The market condition ID
 * @param limit - Maximum holders to fetch (capped at 20)
 * @param minBalance - Minimum balance to include
 */
export async function fetchMarketHolders(
  conditionId: string,
  limit: number = CONFIG.LIMITS.HOLDERS,
  minBalance: number = CONFIG.MARKET_INDEX.MIN_HOLDERS_BALANCE
): Promise<TokenHoldersResponse[]> {
  const url = buildDataApiUrl('/holders', {
    market: conditionId,
    limit: Math.min(limit, 20), // API caps at 20
    minBalance,
  });

  logger.debug(`Fetching holders for market ${conditionId.substring(0, 16)}...`);

  try {
    await sleep(CONFIG.API_DELAY_MS);

    const response = await axios.get<TokenHoldersResponse[]>(url, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      },
    });

    return response.data || [];
  } catch (error: any) {
    if (error.response) {
      // Log but don't throw for 404s (market might not have holders)
      if (error.response.status === 404) {
        logger.warn(`No holders found for market ${conditionId.substring(0, 16)}...`);
        return [];
      }
      logger.error(`API error: ${error.response.status} - ${error.response.statusText}`);
      throw new Error(`Data API error: ${error.response.status}`);
    }
    throw error;
  }
}

/**
 * Fetch holders for multiple markets (with rate limiting)
 * @param conditionIds - Array of market condition IDs
 * @param onProgress - Optional callback for progress updates
 */
export async function fetchHoldersForMarkets(
  conditionIds: string[],
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, TokenHoldersResponse[]>> {
  const results = new Map<string, TokenHoldersResponse[]>();

  logger.info(`Fetching holders for ${conditionIds.length} markets...`);

  for (let i = 0; i < conditionIds.length; i++) {
    const conditionId = conditionIds[i];

    try {
      const holders = await fetchMarketHolders(conditionId);
      results.set(conditionId, holders);

      if (onProgress) {
        onProgress(i + 1, conditionIds.length);
      }

      // Log progress every 10 markets
      if ((i + 1) % 10 === 0) {
        logger.info(`Progress: ${i + 1}/${conditionIds.length} markets processed`);
      }
    } catch (error) {
      logger.error(`Failed to fetch holders for ${conditionId}: ${error}`);
      results.set(conditionId, []);
    }
  }

  logger.success(`Fetched holders for ${results.size} markets`);

  return results;
}

/**
 * Extract unique wallet addresses from holders response
 */
export function extractUniqueWallets(holdersMap: Map<string, TokenHoldersResponse[]>): string[] {
  const wallets = new Set<string>();

  holdersMap.forEach((tokenHolders) => {
    tokenHolders.forEach((th) => {
      th.holders.forEach((holder) => {
        if (holder.proxyWallet) {
          wallets.add(holder.proxyWallet.toLowerCase());
        }
      });
    });
  });

  return Array.from(wallets);
}

/**
 * Get top N holders across all markets by total holdings
 */
export function getTopHoldersAcrossMarkets(
  holdersMap: Map<string, TokenHoldersResponse[]>,
  topN: number = 100
): { wallet: string; totalAmount: number; marketCount: number }[] {
  const walletStats = new Map<string, { totalAmount: number; marketCount: number }>();

  holdersMap.forEach((tokenHolders) => {
    tokenHolders.forEach((th) => {
      th.holders.forEach((holder) => {
        const wallet = holder.proxyWallet.toLowerCase();
        const existing = walletStats.get(wallet) || { totalAmount: 0, marketCount: 0 };
        existing.totalAmount += holder.amount || 0;
        existing.marketCount += 1;
        walletStats.set(wallet, existing);
      });
    });
  });

  // Convert to array and sort by total amount
  const sorted = Array.from(walletStats.entries())
    .map(([wallet, stats]) => ({ wallet, ...stats }))
    .sort((a, b) => b.totalAmount - a.totalAmount)
    .slice(0, topN);

  return sorted;
}
