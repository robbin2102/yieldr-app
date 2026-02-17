/**
 * Polymarket Markets API Client
 * Fetches market data from Gamma API
 */

import axios from 'axios';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/pagination';

const logger = createLogger('Markets API');

/**
 * Raw market response from Gamma API
 */
export interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  twitterCardImage?: string;
  resolutionSource?: string;
  endDate?: string;
  category?: string;
  ammType?: string;
  liquidity?: string;
  sponsorName?: string;
  sponsorImage?: string;
  startDate?: string;
  xAxisValue?: string;
  yAxisValue?: string;
  denominationToken?: string;
  fee?: string;
  image?: string;
  icon?: string;
  lowerBound?: string;
  upperBound?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: string;
  active?: boolean;
  marketType?: string;
  formatType?: string;
  lowerBoundDate?: string;
  upperBoundDate?: string;
  closed?: boolean;
  marketMakerAddress?: string;
  createdBy?: number;
  updatedBy?: number;
  createdAt?: string;
  updatedAt?: string;
  closedTime?: string;
  wideFormat?: boolean;
  new?: boolean;
  mailchimpTag?: string;
  featured?: boolean;
  archived?: boolean;
  resolvedBy?: string;
  restricted?: boolean;
  marketGroup?: number;
  groupItemTitle?: string;
  groupItemThreshold?: string;
  questionID?: string;
  umaEndDate?: string;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  umaResolutionStatus?: string;
  curationOrder?: number;
  volumeNum?: number;
  liquidityNum?: number;
  endDateIso?: string;
  startDateIso?: string;
  umaEndDateIso?: string;
  hasReviewedDates?: boolean;
  readyForCron?: boolean;
  commentsEnabled?: boolean;
  volume24hr?: number;
  volume1wk?: number;
  volume1mo?: number;
  volume1yr?: number;
  gameStartTime?: string;
  secondsDelay?: number;
  clobTokenIds?: string;
  disqusThread?: string;
  shortOutcomes?: string;
  teamAID?: string;
  teamBID?: string;
  umaBond?: string;
  umaReward?: string;
  fpmmLive?: boolean;
  volume24hrAmm?: number;
  volume1wkAmm?: number;
  volume1moAmm?: number;
  volume1yrAmm?: number;
  volume24hrClob?: number;
  volume1wkClob?: number;
  volume1moClob?: number;
  volume1yrClob?: number;
  volumeAmm?: number;
  volumeClob?: number;
  liquidityAmm?: number;
  liquidityClob?: number;
  makerBaseFee?: number;
  takerBaseFee?: number;
  customLiveness?: number;
  acceptingOrders?: boolean;
  notificationsEnabled?: boolean;
  score?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  spread?: number;
  oneDayPriceChange?: number;
  oneHourPriceChange?: number;
  oneWeekPriceChange?: number;
  oneMonthPriceChange?: number;
  oneYearPriceChange?: number;
  competitive?: number;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  ready?: boolean;
  funded?: boolean;
  creator?: string;
  pastSlugs?: string;
  readyTimestamp?: string;
  fundedTimestamp?: string;
  acceptingOrdersTimestamp?: string;
  pendingDeployment?: boolean;
  deploying?: boolean;
  deployingTimestamp?: string;
  scheduledDeploymentTimestamp?: string;
  rfqEnabled?: boolean;
  eventStartTime?: string;
  automaticallyActive?: boolean;
  automaticallyResolved?: boolean;
  clearBookOnStart?: boolean;
  manualActivation?: boolean;
  negRiskOther?: boolean;
  showGmpSeries?: boolean;
  showGmpOutcome?: boolean;
  groupItemRange?: string;
  sportsMarketType?: string;
  line?: number;
  gameId?: string;
  imageOptimized?: any;
  iconOptimized?: any;
  events?: any[];
  categories?: any[];
  tags?: any[];
}

/**
 * Build URL for Gamma API
 */
function buildGammaUrl(
  endpoint: string,
  params: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(`${CONFIG.GAMMA_API_BASE}${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  });

  return url.toString();
}

/**
 * Fetch markets from Gamma API with parameters
 */
export async function fetchMarkets(params: {
  limit?: number;
  offset?: number;
  closed?: boolean;
  active?: boolean;
  end_date_min?: string;
  end_date_max?: string;
  volume_num_min?: number;
  tag?: string;  // Filter by tag (sports, politics, finance, economics)
}): Promise<GammaMarketResponse[]> {
  const url = buildGammaUrl('/markets', params);

  logger.debug(`Fetching: ${url}`);

  try {
    await sleep(CONFIG.API_DELAY_MS);

    const response = await axios.get<GammaMarketResponse[]>(url, {
      timeout: 30000,
      headers: {
        'Accept': 'application/json',
      },
    });

    return response.data || [];
  } catch (error: any) {
    if (error.response) {
      logger.error(`API error: ${error.response.status} - ${error.response.statusText}`);
      throw new Error(`Gamma API error: ${error.response.status}`);
    }
    throw error;
  }
}

/**
 * Fetch all markets ending within specified days with volume filter
 * Uses pagination to get all results
 * @param days - Days ahead to look for markets
 * @param minVolume - Minimum volume filter
 * @param tag - Optional tag filter (sports, politics, finance, economics)
 */
export async function fetchMarketsEndingWithinDays(
  days: number = CONFIG.DAYS.MARKET_END_WINDOW,
  minVolume: number = CONFIG.MARKET_INDEX.MIN_VOLUME,
  tag?: string
): Promise<GammaMarketResponse[]> {
  const now = new Date();
  const endDateMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Format dates as ISO strings
  const endDateMinStr = now.toISOString();
  const endDateMaxStr = endDateMax.toISOString();

  logger.info(`Fetching markets ending between ${endDateMinStr} and ${endDateMaxStr}`);
  logger.info(`Minimum volume filter: $${minVolume.toLocaleString()}`);
  if (tag) {
    logger.info(`Tag filter: ${tag}`);
  }

  const allMarkets: GammaMarketResponse[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    logger.info(`Fetching page at offset ${offset}...`);

    const markets = await fetchMarkets({
      limit: CONFIG.LIMITS.MARKETS,
      offset,
      closed: false,
      active: true,
      end_date_min: endDateMinStr,
      end_date_max: endDateMaxStr,
      volume_num_min: minVolume,
      tag,
    });

    if (markets.length === 0) {
      hasMore = false;
      logger.info(`No more markets at offset ${offset}`);
    } else {
      allMarkets.push(...markets);
      logger.info(`Fetched ${markets.length} markets (total: ${allMarkets.length})`);

      // If we got fewer than the limit, we've reached the end
      if (markets.length < CONFIG.LIMITS.MARKETS) {
        hasMore = false;
      } else {
        offset += CONFIG.LIMITS.MARKETS;
      }
    }
  }

  logger.success(`Total markets fetched: ${allMarkets.length}`);

  return allMarkets;
}

/**
 * Fetch markets for multiple tags with deduplication
 * Makes separate API requests per tag and combines results
 * @param days - Days ahead to look for markets
 * @param minVolume - Minimum volume filter
 * @param tags - Array of tags to fetch (sports, politics, finance, economics)
 */
export async function fetchMarketsByTags(
  days: number = CONFIG.DAYS.MARKET_END_WINDOW,
  minVolume: number = CONFIG.MARKET_INDEX.MIN_VOLUME,
  tags: string[]
): Promise<GammaMarketResponse[]> {
  if (!tags || tags.length === 0) {
    // No tags specified, fetch all markets
    return fetchMarketsEndingWithinDays(days, minVolume);
  }

  logger.info(`\nFetching markets for ${tags.length} tags: ${tags.join(', ')}`);

  const allMarkets: GammaMarketResponse[] = [];
  const seenConditionIds = new Set<string>();

  for (const tag of tags) {
    logger.info(`\n--- Fetching tag: ${tag} ---`);

    try {
      const markets = await fetchMarketsEndingWithinDays(days, minVolume, tag);

      // Deduplicate by conditionId
      let newCount = 0;
      for (const market of markets) {
        if (!seenConditionIds.has(market.conditionId)) {
          seenConditionIds.add(market.conditionId);
          allMarkets.push(market);
          newCount++;
        }
      }

      logger.info(`Tag "${tag}": ${markets.length} fetched, ${newCount} new (${markets.length - newCount} duplicates)`);
    } catch (error: any) {
      logger.error(`Failed to fetch tag "${tag}": ${error.message}`);
    }
  }

  logger.success(`\nTotal unique markets across all tags: ${allMarkets.length}`);

  return allMarkets;
}

/**
 * Calculate days until market ends
 */
export function calculateDaysUntilEnd(endDate: string | Date): number {
  const end = new Date(endDate);
  const now = new Date();
  const diffMs = end.getTime() - now.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}
