/**
 * Polymarket API Client
 * Adapted from polymarket-indexer and polymarket-tracker services
 */

import axios from 'axios';
import { CONFIG } from '../config';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

export interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

export interface ClosedPosition {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description?: string;
  category?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  volumeNum?: number;
  volume24hr?: number;
  liquidity?: string;
  liquidityNum?: number;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  startDate?: string;
  image?: string;
  icon?: string;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  oneHourPriceChange?: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  events?: any[];
  tags?: any[];
  [key: string]: any; // Allow additional fields
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(
  url: string,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sleep(CONFIG.API_DELAY_MS);
      const response = await axios.get<T>(url, {
        timeout: 30000,
        headers: { 'Accept': 'application/json' },
      });
      return response.data;
    } catch (error: any) {
      lastError = error;

      // Rate limited - exponential backoff
      if (error.response?.status === 429) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.warn(`[API] Rate limited, waiting ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

      // Server error - retry
      if (error.response?.status >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

// ═══════════════════════════════════════════════════════════════
// Data API - Trader Activities & Positions
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch recent activities for a wallet (time-based, paginated)
 */
export async function fetchActivities(
  wallet: string,
  days: number
): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - days * 24 * 60 * 60;
  const MAX_OFFSET = 10000;

  const allActivities: Activity[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${CONFIG.DATA_API_BASE}/activity?user=${wallet}&limit=${CONFIG.LIMITS.ACTIVITIES}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;

    let data: Activity[];
    try {
      data = await fetchWithRetry<Activity[]>(url);
    } catch (error: any) {
      // 400 at high offsets = Polymarket pagination cap
      if (error.response?.status === 400) break;
      throw error;
    }

    if (!data || data.length === 0) break;

    for (const activity of data) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        done = true;
        break;
      }
    }

    if (data.length < CONFIG.LIMITS.ACTIVITIES) break;
    offset += CONFIG.LIMITS.ACTIVITIES;
  }

  return allActivities;
}

/**
 * Fetch activities since a specific timestamp
 */
export async function fetchActivitiesSince(
  wallet: string,
  sinceTimestamp: number,
  limit: number = 50
): Promise<Activity[]> {
  const url = `${CONFIG.DATA_API_BASE}/activity?user=${wallet}&startTs=${sinceTimestamp}&limit=${limit}`;
  return fetchWithRetry<Activity[]>(url);
}

/**
 * Fetch ALL open positions for a wallet (paginated, handles 400 cap)
 */
export async function fetchOpenPositions(
  wallet: string
): Promise<OpenPosition[]> {
  const MAX_OFFSET = 10000;
  const allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${CONFIG.DATA_API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${CONFIG.LIMITS.POSITIONS}&offset=${offset}`;

    let data: OpenPosition[];
    try {
      data = await fetchWithRetry<OpenPosition[]>(url);
    } catch (error: any) {
      if (error.response?.status === 400) break;
      throw error;
    }

    if (!data || data.length === 0) break;
    allPositions.push(...data);

    if (data.length < CONFIG.LIMITS.POSITIONS) break;
    offset += CONFIG.LIMITS.POSITIONS;
  }

  return allPositions;
}

/**
 * Fetch closed positions for a wallet.
 * Supports two modes:
 * - { days } → fetch all closed positions within the time window
 * - { limit } → fetch the last N closed positions regardless of time
 * Default: last 1000 closed positions (for accurate win rate)
 */
export async function fetchClosedPositions(
  wallet: string,
  options: { days?: number; limit?: number } = { limit: 1000 }
): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = options.days ? now - (options.days * 24 * 60 * 60) : null;
  const targetLimit = options.limit ?? null;
  const LIMIT = CONFIG.LIMITS.CLOSED_POSITIONS; // API max per request
  const MAX_OFFSET = 100000;

  const allPositions: ClosedPosition[] = [];
  let offset = 0;
  let done = false;

  while (!done && offset <= MAX_OFFSET) {
    const url = `${CONFIG.DATA_API_BASE}/v1/closed-positions?user=${wallet}&limit=${LIMIT}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;

    let data: ClosedPosition[];
    try {
      data = await fetchWithRetry<ClosedPosition[]>(url);
    } catch (error: any) {
      // 400 at high offsets = Polymarket pagination cap
      if (error.response?.status === 400) break;
      throw error;
    }

    if (!data || data.length === 0) break;

    for (const pos of data) {
      // Days filter: stop when we go past the time window
      if (startTs !== null && pos.timestamp < startTs) {
        done = true;
        break;
      }

      allPositions.push(pos);

      // Limit filter: stop when we reach the target
      if (targetLimit !== null && allPositions.length >= targetLimit) {
        done = true;
        break;
      }
    }

    if (data.length < LIMIT) break;
    offset += LIMIT;
  }

  return allPositions;
}

/**
 * Fetch public profile for a wallet (identity, pseudonym, X username)
 */
export interface PublicProfile {
  createdAt?: string;
  pseudonym?: string;
  name?: string;
  xUsername?: string;
}

export async function fetchPublicProfile(wallet: string): Promise<PublicProfile | null> {
  try {
    await sleep(200);
    const url = `${CONFIG.DATA_API_BASE}/public-profile?address=${wallet}`;
    const data = await fetchWithRetry<PublicProfile>(url);
    return data || null;
  } catch {
    return null;
  }
}

/**
 * Fetch first-ever activity for a wallet (for dormancy detection)
 */
export async function fetchFirstActivity(wallet: string): Promise<Activity | null> {
  try {
    await sleep(100);
    const url = `${CONFIG.DATA_API_BASE}/activity?user=${wallet}&limit=1&offset=0&sortBy=TIMESTAMP&sortDirection=ASC`;
    const data = await fetchWithRetry<Activity[]>(url);
    return data && data.length > 0 ? data[0] : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Gamma API - Markets
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch markets ending within specified days with volume filter
 */
export async function fetchMarketsEndingWithinDays(
  days: number = CONFIG.MARKET_DAYS_WINDOW,
  minVolume: number = CONFIG.MARKET_MIN_VOLUME
): Promise<GammaMarket[]> {
  const now = new Date();
  const endDateMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const endDateMinStr = now.toISOString();
  const endDateMaxStr = endDateMax.toISOString();

  const allMarkets: GammaMarket[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      limit: String(CONFIG.MARKETS_PER_PAGE),
      offset: String(offset),
      closed: 'false',
      active: 'true',
      end_date_min: endDateMinStr,
      end_date_max: endDateMaxStr,
      volume_num_min: String(minVolume),
    });

    const url = `${CONFIG.GAMMA_API_BASE}/markets?${params}`;
    const data = await fetchWithRetry<GammaMarket[]>(url);

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allMarkets.push(...data);
      if (data.length < CONFIG.MARKETS_PER_PAGE) {
        hasMore = false;
      } else {
        offset += CONFIG.MARKETS_PER_PAGE;
      }
    }
  }

  return allMarkets;
}
