/**
 * Market Indexer Service
 * Fetches and indexes Polymarket markets ending within 30 days
 */

import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import {
  fetchMarketsEndingWithinDays,
  calculateDaysUntilEnd,
  GammaMarketResponse,
} from '../api/markets';
import PolyMarket, { IPolyMarket } from '../../../models/PolyMarket';

const logger = createLogger('Market Indexer');

/**
 * Transform API response to MongoDB document
 */
function transformMarketToDocument(market: GammaMarketResponse): Partial<IPolyMarket> {
  const now = new Date();

  return {
    // Identifiers
    id: market.id,
    conditionId: market.conditionId,
    slug: market.slug,
    questionID: market.questionID,

    // Market Info
    question: market.question,
    description: market.description,
    category: market.category,
    outcomes: market.outcomes,
    outcomePrices: market.outcomePrices,
    shortOutcomes: market.shortOutcomes,
    marketType: market.marketType,
    formatType: market.formatType,
    ammType: market.ammType,

    // Dates
    startDate: market.startDate ? new Date(market.startDate) : undefined,
    endDate: market.endDate ? new Date(market.endDate) : new Date(),
    endDateIso: market.endDateIso,
    startDateIso: market.startDateIso,
    createdAt: market.createdAt ? new Date(market.createdAt) : undefined,
    updatedAt: market.updatedAt ? new Date(market.updatedAt) : undefined,
    closedTime: market.closedTime,
    umaEndDate: market.umaEndDate,
    umaEndDateIso: market.umaEndDateIso,

    // Volume & Liquidity
    volume: market.volume,
    volumeNum: market.volumeNum,
    volume24hr: market.volume24hr,
    volume1wk: market.volume1wk,
    volume1mo: market.volume1mo,
    volume1yr: market.volume1yr,
    liquidity: market.liquidity,
    liquidityNum: market.liquidityNum,
    liquidityAmm: market.liquidityAmm,
    liquidityClob: market.liquidityClob,

    // AMM vs CLOB breakdown
    volume24hrAmm: market.volume24hrAmm,
    volume1wkAmm: market.volume1wkAmm,
    volume1moAmm: market.volume1moAmm,
    volume1yrAmm: market.volume1yrAmm,
    volume24hrClob: market.volume24hrClob,
    volume1wkClob: market.volume1wkClob,
    volume1moClob: market.volume1moClob,
    volume1yrClob: market.volume1yrClob,
    volumeAmm: market.volumeAmm,
    volumeClob: market.volumeClob,

    // Status Flags
    active: market.active,
    closed: market.closed,
    archived: market.archived,
    new: market.new,
    featured: market.featured,
    restricted: market.restricted,
    wideFormat: market.wideFormat,
    enableOrderBook: market.enableOrderBook,
    acceptingOrders: market.acceptingOrders,
    fpmmLive: market.fpmmLive,
    ready: market.ready,
    funded: market.funded,
    commentsEnabled: market.commentsEnabled,
    notificationsEnabled: market.notificationsEnabled,

    // CLOB Info
    clobTokenIds: market.clobTokenIds,
    orderPriceMinTickSize: market.orderPriceMinTickSize,
    orderMinSize: market.orderMinSize,
    makerBaseFee: market.makerBaseFee,
    takerBaseFee: market.takerBaseFee,

    // Media
    image: market.image,
    icon: market.icon,
    twitterCardImage: market.twitterCardImage,

    // Resolution
    resolutionSource: market.resolutionSource,
    umaResolutionStatus: market.umaResolutionStatus,
    resolvedBy: market.resolvedBy,
    automaticallyResolved: market.automaticallyResolved,

    // Pricing
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    lastTradePrice: market.lastTradePrice,
    spread: market.spread,
    fee: market.fee,

    // Price Changes
    oneHourPriceChange: market.oneHourPriceChange,
    oneDayPriceChange: market.oneDayPriceChange,
    oneWeekPriceChange: market.oneWeekPriceChange,
    oneMonthPriceChange: market.oneMonthPriceChange,
    oneYearPriceChange: market.oneYearPriceChange,

    // Bounds
    lowerBound: market.lowerBound,
    upperBound: market.upperBound,
    lowerBoundDate: market.lowerBoundDate,
    upperBoundDate: market.upperBoundDate,

    // Sponsor
    sponsorName: market.sponsorName,
    sponsorImage: market.sponsorImage,

    // Market Group
    marketGroup: market.marketGroup,
    groupItemTitle: market.groupItemTitle,
    groupItemThreshold: market.groupItemThreshold,
    groupItemRange: market.groupItemRange,

    // UMA
    umaBond: market.umaBond,
    umaReward: market.umaReward,
    customLiveness: market.customLiveness,

    // Sports
    gameStartTime: market.gameStartTime,
    secondsDelay: market.secondsDelay,
    teamAID: market.teamAID,
    teamBID: market.teamBID,
    sportsMarketType: market.sportsMarketType,
    line: market.line,
    gameId: market.gameId,

    // Misc
    denominationToken: market.denominationToken,
    xAxisValue: market.xAxisValue,
    yAxisValue: market.yAxisValue,
    curationOrder: market.curationOrder,
    score: market.score,
    competitive: market.competitive,
    rewardsMinSize: market.rewardsMinSize,
    rewardsMaxSpread: market.rewardsMaxSpread,
    creator: market.creator,
    createdBy: market.createdBy,
    updatedBy: market.updatedBy,
    marketMakerAddress: market.marketMakerAddress,
    disqusThread: market.disqusThread,
    mailchimpTag: market.mailchimpTag,
    pastSlugs: market.pastSlugs,

    // Timestamps
    readyTimestamp: market.readyTimestamp ? new Date(market.readyTimestamp) : undefined,
    fundedTimestamp: market.fundedTimestamp ? new Date(market.fundedTimestamp) : undefined,
    acceptingOrdersTimestamp: market.acceptingOrdersTimestamp ? new Date(market.acceptingOrdersTimestamp) : undefined,
    deployingTimestamp: market.deployingTimestamp ? new Date(market.deployingTimestamp) : undefined,
    scheduledDeploymentTimestamp: market.scheduledDeploymentTimestamp ? new Date(market.scheduledDeploymentTimestamp) : undefined,
    eventStartTime: market.eventStartTime ? new Date(market.eventStartTime) : undefined,

    // Flags
    pendingDeployment: market.pendingDeployment,
    deploying: market.deploying,
    rfqEnabled: market.rfqEnabled,
    hasReviewedDates: market.hasReviewedDates,
    readyForCron: market.readyForCron,
    automaticallyActive: market.automaticallyActive,
    clearBookOnStart: market.clearBookOnStart,
    manualActivation: market.manualActivation,
    negRiskOther: market.negRiskOther,
    showGmpSeries: market.showGmpSeries,
    showGmpOutcome: market.showGmpOutcome,

    // Optimized images
    imageOptimized: market.imageOptimized,
    iconOptimized: market.iconOptimized,

    // Related data
    events: market.events?.map((e: any) => ({
      id: e.id,
      title: e.title,
      slug: e.slug,
      ticker: e.ticker,
      category: e.category,
      subcategory: e.subcategory,
      description: e.description,
      startDate: e.startDate ? new Date(e.startDate) : undefined,
      endDate: e.endDate ? new Date(e.endDate) : undefined,
      active: e.active,
      closed: e.closed,
      volume: e.volume,
      liquidity: e.liquidity,
      negRisk: e.negRisk,
      negRiskMarketID: e.negRiskMarketID,
    })),
    categories: market.categories?.map((c: any) => ({
      id: c.id,
      label: c.label,
      parentCategory: c.parentCategory,
      slug: c.slug,
      publishedAt: c.publishedAt,
      createdAt: c.createdAt ? new Date(c.createdAt) : undefined,
      updatedAt: c.updatedAt ? new Date(c.updatedAt) : undefined,
    })),
    tags: market.tags?.map((t: any) => ({
      id: t.id,
      label: t.label,
      slug: t.slug,
      forceShow: t.forceShow,
      forceHide: t.forceHide,
      isCarousel: t.isCarousel,
      publishedAt: t.publishedAt,
      createdAt: t.createdAt ? new Date(t.createdAt) : undefined,
      updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
    })),

    // Our tracking fields
    fetchedAt: now,
    daysUntilEnd: market.endDate ? calculateDaysUntilEnd(market.endDate) : 0,
    holdersIndexed: false,
  };
}

/**
 * Index result statistics
 */
export interface IndexResult {
  totalFetched: number;
  inserted: number;
  updated: number;
  failed: number;
  durationMs: number;
  categories: Record<string, number>;
  volumeStats: {
    min: number;
    max: number;
    avg: number;
    total: number;
  };
}

// Target categories for filtering (case-insensitive matching)
export const TARGET_CATEGORIES = [
  'sports',
  'politics',
  'economics',
  'finance',
  'economy',
];

/**
 * Check if a market matches target categories
 */
function matchesTargetCategory(market: GammaMarketResponse, categoryFilter: string[]): boolean {
  if (!categoryFilter || categoryFilter.length === 0) return true;

  const marketCategory = (market.category || '').toLowerCase();
  if (categoryFilter.some(c => marketCategory.includes(c.toLowerCase()))) return true;

  // Check events categories
  if (market.events && Array.isArray(market.events)) {
    for (const event of market.events as any[]) {
      const eventCategory = (event.category || '').toLowerCase();
      const eventSubcategory = (event.subcategory || '').toLowerCase();
      if (categoryFilter.some(c => {
        const lc = c.toLowerCase();
        return eventCategory.includes(lc) || eventSubcategory.includes(lc);
      })) return true;
    }
  }

  // Check categories array
  if (market.categories && Array.isArray(market.categories)) {
    for (const cat of market.categories as any[]) {
      const catLabel = (cat.label || '').toLowerCase();
      const parentCat = (cat.parentCategory || '').toLowerCase();
      if (categoryFilter.some(c => {
        const lc = c.toLowerCase();
        return catLabel.includes(lc) || parentCat.includes(lc);
      })) return true;
    }
  }

  return false;
}

/**
 * Index all markets ending within specified days
 * Upserts data (updates existing, inserts new)
 * @param days - Days ahead to look for markets
 * @param minVolume - Minimum volume filter
 * @param categoryFilter - Optional array of categories to filter by
 */
export async function indexMarketsEndingWithinDays(
  days: number = CONFIG.DAYS.MARKET_END_WINDOW,
  minVolume: number = CONFIG.MARKET_INDEX.MIN_VOLUME,
  categoryFilter: string[] = []
): Promise<IndexResult> {
  const startTime = Date.now();

  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('             POLYMARKET MARKET INDEXER                          ');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info(`Days ahead: ${days}`);
  logger.info(`Min volume: $${minVolume.toLocaleString()}`);
  if (categoryFilter.length > 0) {
    logger.info(`Category filter: ${categoryFilter.join(', ')}`);
  }
  logger.info('═══════════════════════════════════════════════════════════════\n');

  // Fetch markets from API
  let markets = await fetchMarketsEndingWithinDays(days, minVolume);

  // Apply category filter if specified
  if (categoryFilter.length > 0) {
    const beforeCount = markets.length;
    markets = markets.filter(m => matchesTargetCategory(m, categoryFilter));
    logger.info(`Category filter: ${beforeCount} → ${markets.length} markets`);
  }

  if (markets.length === 0) {
    logger.warn('No markets found matching criteria');
    return {
      totalFetched: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      durationMs: Date.now() - startTime,
      categories: {},
      volumeStats: { min: 0, max: 0, avg: 0, total: 0 },
    };
  }

  // Track statistics
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  const categories: Record<string, number> = {};
  const volumes: number[] = [];

  logger.info(`\nProcessing ${markets.length} markets using bulk write...`);

  // Prepare bulk operations
  const bulkOps = markets.map((market) => {
    const doc = transformMarketToDocument(market);

    // Track category
    if (market.category) {
      categories[market.category] = (categories[market.category] || 0) + 1;
    }

    // Track volume
    if (market.volumeNum) {
      volumes.push(market.volumeNum);
    }

    return {
      updateOne: {
        filter: { id: market.id },
        update: { $set: doc },
        upsert: true,
      },
    };
  });

  // Execute bulk write in batches of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
    const batch = bulkOps.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(bulkOps.length / BATCH_SIZE);

    logger.info(`  Writing batch ${batchNum}/${totalBatches} (${batch.length} markets)...`);

    try {
      const result = await PolyMarket.bulkWrite(batch, { ordered: false });
      inserted += result.upsertedCount;
      updated += result.modifiedCount;
    } catch (error: any) {
      logger.error(`Batch ${batchNum} failed: ${error.message}`);
      failed += batch.length;
    }
  }

  // Calculate volume stats
  const volumeStats = {
    min: volumes.length > 0 ? Math.min(...volumes) : 0,
    max: volumes.length > 0 ? Math.max(...volumes) : 0,
    avg: volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0,
    total: volumes.reduce((a, b) => a + b, 0),
  };

  const durationMs = Date.now() - startTime;

  // Log summary
  logger.info('\n═══════════════════════════════════════════════════════════════');
  logger.info('                    INDEXING COMPLETE                           ');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.success(`Total fetched: ${markets.length}`);
  logger.success(`Inserted: ${inserted}`);
  logger.success(`Updated: ${updated}`);
  if (failed > 0) logger.error(`Failed: ${failed}`);
  logger.info(`\nDuration: ${(durationMs / 1000).toFixed(2)}s`);

  logger.info('\nCategories:');
  Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, count]) => {
      logger.info(`  ${cat}: ${count}`);
    });

  logger.info('\nVolume Stats:');
  logger.info(`  Min: $${volumeStats.min.toLocaleString()}`);
  logger.info(`  Max: $${volumeStats.max.toLocaleString()}`);
  logger.info(`  Avg: $${Math.round(volumeStats.avg).toLocaleString()}`);
  logger.info(`  Total: $${Math.round(volumeStats.total).toLocaleString()}`);
  logger.info('═══════════════════════════════════════════════════════════════\n');

  return {
    totalFetched: markets.length,
    inserted,
    updated,
    failed,
    durationMs,
    categories,
    volumeStats,
  };
}

/**
 * Get markets that need holders indexing
 */
export async function getMarketsNeedingHolders(): Promise<IPolyMarket[]> {
  return PolyMarket.find({
    holdersIndexed: false,
    active: true,
    closed: false,
  }).sort({ volumeNum: -1 }).lean();
}

/**
 * Mark market as holders indexed
 */
export async function markMarketHoldersIndexed(marketId: string): Promise<void> {
  await PolyMarket.updateOne(
    { id: marketId },
    {
      $set: {
        holdersIndexed: true,
        holdersIndexedAt: new Date(),
      },
    }
  );
}

/**
 * Get summary of indexed markets
 */
export async function getMarketsSummary(): Promise<{
  total: number;
  byCategory: Record<string, number>;
  holdersIndexed: number;
  holdersNotIndexed: number;
  endingIn7Days: number;
  endingIn30Days: number;
}> {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [
    total,
    holdersIndexed,
    holdersNotIndexed,
    endingIn7Days,
    endingIn30Days,
    categoryAgg,
  ] = await Promise.all([
    PolyMarket.countDocuments({}),
    PolyMarket.countDocuments({ holdersIndexed: true }),
    PolyMarket.countDocuments({ holdersIndexed: false }),
    PolyMarket.countDocuments({ endDate: { $gte: now, $lte: in7Days } }),
    PolyMarket.countDocuments({ endDate: { $gte: now, $lte: in30Days } }),
    PolyMarket.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);

  const byCategory: Record<string, number> = {};
  categoryAgg.forEach((item: { _id: string; count: number }) => {
    if (item._id) {
      byCategory[item._id] = item.count;
    }
  });

  return {
    total,
    byCategory,
    holdersIndexed,
    holdersNotIndexed,
    endingIn7Days,
    endingIn30Days,
  };
}
