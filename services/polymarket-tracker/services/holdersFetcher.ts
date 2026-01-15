/**
 * Holders Fetcher Service
 * Fetches top 20 holders for each indexed market
 */

import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { fetchMarketHolders, TokenHoldersResponse } from '../api/holders';
import PolyMarket, { IPolyMarket } from '../../../models/PolyMarket';
import PolyMarketHolder from '../../../models/PolyMarketHolder';
import { getMarketsNeedingHolders, markMarketHoldersIndexed } from './marketIndexer';

const logger = createLogger('Holders Fetcher');

/**
 * Result of holders fetching operation
 */
export interface HoldersFetchResult {
  marketsProcessed: number;
  holdersInserted: number;
  holdersUpdated: number;
  failed: number;
  uniqueWallets: number;
  durationMs: number;
}

/**
 * Parse clobTokenIds from market (can be JSON string or comma-separated)
 */
function parseClobTokenIds(clobTokenIds: string | undefined): string[] {
  if (!clobTokenIds) return [];

  try {
    // Try parsing as JSON array
    const parsed = JSON.parse(clobTokenIds);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Not JSON, try comma-separated
  }

  // Handle comma-separated string
  return clobTokenIds.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse outcomes from market (can be JSON string or comma-separated)
 */
function parseOutcomes(outcomes: string | undefined): string[] {
  if (!outcomes) return ['Yes', 'No']; // Default binary outcomes

  try {
    const parsed = JSON.parse(outcomes);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Not JSON
  }

  return outcomes.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Fetch holders for a single market (returns bulk ops for batch write)
 */
async function fetchHoldersForMarket(market: IPolyMarket): Promise<{
  bulkOps: any[];
  wallets: string[];
  failed: boolean;
}> {
  const wallets: string[] = [];
  const bulkOps: any[] = [];

  try {
    // Fetch holders using conditionId
    const tokenHolders = await fetchMarketHolders(market.conditionId);

    if (tokenHolders.length === 0) {
      return { bulkOps: [], wallets, failed: false };
    }

    // Parse outcomes for mapping
    const outcomes = parseOutcomes(market.outcomes);

    // Build bulk ops for each token's holders
    for (const th of tokenHolders) {
      // Determine outcome name from token position
      const tokenIds = parseClobTokenIds(market.clobTokenIds);
      const tokenIndex = tokenIds.indexOf(th.token);
      const outcome = tokenIndex >= 0 && tokenIndex < outcomes.length
        ? outcomes[tokenIndex]
        : `Token ${tokenIndex}`;

      // Collect wallets
      th.holders.forEach((h) => {
        if (h.proxyWallet) {
          wallets.push(h.proxyWallet.toLowerCase());
        }
      });

      // Calculate stats
      const totalAmount = th.holders.reduce((sum, h) => sum + (h.amount || 0), 0);
      const topHolder = th.holders.reduce(
        (max, h) => ((h.amount || 0) > (max?.amount || 0) ? h : max),
        th.holders[0]
      );

      // Add bulk operation
      bulkOps.push({
        updateOne: {
          filter: { conditionId: market.conditionId, tokenId: th.token },
          update: {
            $set: {
              marketId: market.id,
              marketQuestion: market.question,
              marketSlug: market.slug,
              marketCategory: market.category,
              marketEndDate: market.endDate,
              outcome,
              outcomeIndex: tokenIndex >= 0 ? tokenIndex : undefined,
              holders: th.holders.map((h) => ({
                proxyWallet: h.proxyWallet,
                name: h.name,
                pseudonym: h.pseudonym,
                bio: h.bio,
                amount: h.amount,
                displayUsernamePublic: h.displayUsernamePublic,
                outcomeIndex: h.outcomeIndex,
                profileImage: h.profileImage,
                profileImageOptimized: h.profileImageOptimized,
                asset: h.asset,
              })),
              totalHolders: th.holders.length,
              totalAmount,
              topHolderAmount: topHolder?.amount,
              topHolderWallet: topHolder?.proxyWallet,
              fetchedAt: new Date(),
            },
          },
          upsert: true,
        },
      });
    }

    return { bulkOps, wallets, failed: false };
  } catch (error: any) {
    logger.error(`Failed to fetch holders for ${market.slug}: ${error.message}`);
    return { bulkOps: [], wallets, failed: true };
  }
}

/**
 * Fetch holders for all markets that need indexing
 */
export async function fetchHoldersForAllMarkets(): Promise<HoldersFetchResult> {
  const startTime = Date.now();

  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('             POLYMARKET HOLDERS FETCHER                         ');
  logger.info('═══════════════════════════════════════════════════════════════\n');

  // Get markets needing holders
  const markets = await getMarketsNeedingHolders();

  if (markets.length === 0) {
    logger.info('No markets need holders indexing');
    return {
      marketsProcessed: 0,
      holdersInserted: 0,
      holdersUpdated: 0,
      failed: 0,
      uniqueWallets: 0,
      durationMs: Date.now() - startTime,
    };
  }

  logger.info(`Found ${markets.length} markets needing holders indexing\n`);

  let totalInserted = 0;
  let totalUpdated = 0;
  let failed = 0;
  const allWallets = new Set<string>();
  let pendingBulkOps: any[] = [];
  const processedMarketIds: string[] = [];
  const BATCH_SIZE = 100;

  // Process each market - fetch from API
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const progress = `[${i + 1}/${markets.length}]`;

    logger.info(`${progress} Fetching: ${market.question?.substring(0, 50)}...`);

    const result = await fetchHoldersForMarket(market);

    if (result.failed) {
      failed++;
    } else {
      pendingBulkOps.push(...result.bulkOps);
      result.wallets.forEach((w) => allWallets.add(w));
      processedMarketIds.push(market.id);
    }

    // Write to DB in batches of 100 bulk ops
    if (pendingBulkOps.length >= BATCH_SIZE) {
      logger.info(`  Writing batch of ${pendingBulkOps.length} holder records...`);
      try {
        const writeResult = await PolyMarketHolder.bulkWrite(pendingBulkOps, { ordered: false });
        totalInserted += writeResult.upsertedCount;
        totalUpdated += writeResult.modifiedCount;
      } catch (error: any) {
        logger.error(`Batch write failed: ${error.message}`);
      }
      pendingBulkOps = [];

      // Mark processed markets as indexed
      if (processedMarketIds.length > 0) {
        await PolyMarket.updateMany(
          { id: { $in: processedMarketIds } },
          { $set: { holdersIndexed: true, holdersIndexedAt: new Date() } }
        );
        processedMarketIds.length = 0;
      }
    }

    // Log progress every 50 markets
    if ((i + 1) % 50 === 0 || i === markets.length - 1) {
      logger.info(`\n📊 Progress: ${i + 1}/${markets.length} markets fetched`);
      logger.info(`   Pending writes: ${pendingBulkOps.length}`);
      logger.info(`   Unique wallets: ${allWallets.size}\n`);
    }
  }

  // Write any remaining bulk ops
  if (pendingBulkOps.length > 0) {
    logger.info(`  Writing final batch of ${pendingBulkOps.length} holder records...`);
    try {
      const writeResult = await PolyMarketHolder.bulkWrite(pendingBulkOps, { ordered: false });
      totalInserted += writeResult.upsertedCount;
      totalUpdated += writeResult.modifiedCount;
    } catch (error: any) {
      logger.error(`Final batch write failed: ${error.message}`);
    }
  }

  // Mark any remaining processed markets as indexed
  if (processedMarketIds.length > 0) {
    await PolyMarket.updateMany(
      { id: { $in: processedMarketIds } },
      { $set: { holdersIndexed: true, holdersIndexedAt: new Date() } }
    );
  }

  const durationMs = Date.now() - startTime;

  // Log summary
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.info('                  HOLDERS FETCH COMPLETE                        ');
  logger.info('═══════════════════════════════════════════════════════════════');
  logger.success(`Markets processed: ${markets.length}`);
  logger.success(`Holders inserted: ${totalInserted}`);
  logger.success(`Holders updated: ${totalUpdated}`);
  if (failed > 0) logger.error(`Failed: ${failed}`);
  logger.info(`Unique wallets discovered: ${allWallets.size}`);
  logger.info(`Duration: ${(durationMs / 1000).toFixed(2)}s`);
  logger.info('═══════════════════════════════════════════════════════════════\n');

  return {
    marketsProcessed: markets.length,
    holdersInserted: totalInserted,
    holdersUpdated: totalUpdated,
    failed,
    uniqueWallets: allWallets.size,
    durationMs,
  };
}

/**
 * Refresh holders for specific markets
 */
export async function refreshHoldersForMarkets(marketIds: string[]): Promise<HoldersFetchResult> {
  const startTime = Date.now();

  logger.info(`Refreshing holders for ${marketIds.length} markets...`);

  const markets = await PolyMarket.find({ id: { $in: marketIds } }).lean();

  let totalInserted = 0;
  let totalUpdated = 0;
  let failed = 0;
  const allWallets = new Set<string>();
  const allBulkOps: any[] = [];

  for (const market of markets) {
    const result = await fetchHoldersForMarket(market);

    if (result.failed) {
      failed++;
    } else {
      allBulkOps.push(...result.bulkOps);
      result.wallets.forEach((w) => allWallets.add(w));
    }
  }

  // Write all at once
  if (allBulkOps.length > 0) {
    try {
      const writeResult = await PolyMarketHolder.bulkWrite(allBulkOps, { ordered: false });
      totalInserted = writeResult.upsertedCount;
      totalUpdated = writeResult.modifiedCount;
    } catch (error: any) {
      logger.error(`Bulk write failed: ${error.message}`);
    }
  }

  return {
    marketsProcessed: markets.length,
    holdersInserted: totalInserted,
    holdersUpdated: totalUpdated,
    failed,
    uniqueWallets: allWallets.size,
    durationMs: Date.now() - startTime,
  };
}

/**
 * Get top holders across all markets
 */
export async function getTopHoldersAcrossAllMarkets(limit: number = 100): Promise<{
  wallet: string;
  totalAmount: number;
  marketCount: number;
  topMarkets: { question: string; amount: number }[];
}[]> {
  const pipeline = [
    { $unwind: '$holders' },
    {
      $group: {
        _id: '$holders.proxyWallet',
        totalAmount: { $sum: '$holders.amount' },
        marketCount: { $sum: 1 },
        markets: {
          $push: {
            question: '$marketQuestion',
            amount: '$holders.amount',
          },
        },
      },
    },
    { $sort: { totalAmount: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        wallet: '$_id',
        totalAmount: 1,
        marketCount: 1,
        topMarkets: { $slice: ['$markets', 5] },
      },
    },
  ];

  return PolyMarketHolder.aggregate(pipeline);
}

/**
 * Get markets where a specific wallet is a top holder
 */
export async function getMarketsForWallet(walletAddress: string): Promise<{
  conditionId: string;
  marketQuestion: string;
  outcome: string;
  amount: number;
  marketEndDate: Date;
}[]> {
  const wallet = walletAddress.toLowerCase();

  const holdings = await PolyMarketHolder.find({
    'holders.proxyWallet': { $regex: new RegExp(`^${wallet}$`, 'i') },
  }).lean();

  const results: {
    conditionId: string;
    marketQuestion: string;
    outcome: string;
    amount: number;
    marketEndDate: Date;
  }[] = [];

  holdings.forEach((holding) => {
    const holder = holding.holders.find(
      (h) => h.proxyWallet.toLowerCase() === wallet
    );

    if (holder) {
      results.push({
        conditionId: holding.conditionId,
        marketQuestion: holding.marketQuestion || '',
        outcome: holding.outcome || '',
        amount: holder.amount,
        marketEndDate: holding.marketEndDate || new Date(),
      });
    }
  });

  return results.sort((a, b) => b.amount - a.amount);
}
