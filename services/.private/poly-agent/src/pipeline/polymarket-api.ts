/**
 * Polymarket API Client — used by market-indexer
 * Adapted from x-agent-data-service/src/lib/polymarket-api.ts
 */

import axios from 'axios';
import { PIPELINE_CONFIG } from './pipeline-config';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

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
  [key: string]: any;
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry<T>(url: string, maxRetries = 3): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await sleep(PIPELINE_CONFIG.API_DELAY_MS);
      const response = await axios.get<T>(url, {
        timeout: 30_000,
        headers: { Accept: 'application/json' },
      });
      return response.data;
    } catch (error: any) {
      lastError = error;

      if (error.response?.status === 429) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.warn(`[API] Rate limited, waiting ${backoff}ms...`);
        await sleep(backoff);
        continue;
      }

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
// Gamma API — Markets
// ═══════════════════════════════════════════════════════════════

export async function fetchMarketsEndingWithinDays(
  days: number = PIPELINE_CONFIG.MARKET_DAYS_WINDOW,
  minVolume: number = PIPELINE_CONFIG.MARKET_MIN_VOLUME,
): Promise<GammaMarket[]> {
  const now = new Date();
  const endDateMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const allMarkets: GammaMarket[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      limit:          String(PIPELINE_CONFIG.MARKETS_PER_PAGE),
      offset:         String(offset),
      closed:         'false',
      active:         'true',
      end_date_min:   now.toISOString(),
      end_date_max:   endDateMax.toISOString(),
      volume_num_min: String(minVolume),
    });

    const url = `${PIPELINE_CONFIG.GAMMA_API_BASE}/markets?${params}`;
    const data = await fetchWithRetry<GammaMarket[]>(url);

    if (!data || data.length === 0) {
      hasMore = false;
    } else {
      allMarkets.push(...data);
      hasMore = data.length >= PIPELINE_CONFIG.MARKETS_PER_PAGE;
      offset += PIPELINE_CONFIG.MARKETS_PER_PAGE;
    }
  }

  return allMarkets;
}
