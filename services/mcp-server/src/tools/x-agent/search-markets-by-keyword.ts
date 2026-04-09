/**
 * search_markets_by_keyword Tool
 * Search Polymarket markets by keywords to match trending topics
 */

import { z } from 'zod';
import { getDB } from '../../db/mongodb.js';

const COLLECTION = 'polyMarkets';

export const searchMarketsByKeywordSchema = z.object({
  keywords: z.array(z.string()).describe('Array of keywords to search for in market questions/descriptions'),
  activeOnly: z.boolean().optional().default(true).describe('Only return active (not closed) markets'),
  minVolume: z.number().optional().describe('Minimum volume filter in USD (e.g. 50000)'),
  category: z.string().optional().describe('Filter by category (e.g. Sports, Politics, Crypto)'),
  limit: z.number().optional().default(10).describe('Number of markets to return (default: 10)'),
});

export type SearchMarketsByKeywordInput = z.infer<typeof searchMarketsByKeywordSchema>;

export async function executeSearchMarketsByKeyword(input: SearchMarketsByKeywordInput) {
  const db = await getDB();
  const collection = db.collection(COLLECTION);

  // Build search query - try text search first, fall back to regex
  let markets: any[];

  // Build regex pattern from keywords
  const regexPatterns = input.keywords.map(k => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  const filter: any = {
    $or: regexPatterns.flatMap(pattern => [
      { question: { $regex: pattern } },
      { description: { $regex: pattern } },
    ]),
  };

  if (input.activeOnly) {
    filter.active = true;
    filter.closed = { $ne: true };
  }
  if (input.minVolume) {
    filter.volumeNum = { $gte: input.minVolume };
  }
  if (input.category) {
    filter.category = { $regex: new RegExp(input.category, 'i') };
  }

  markets = await collection
    .find(filter)
    .sort({ volumeNum: -1 })
    .limit(input.limit || 10)
    .toArray();

  return {
    markets: markets.map(m => ({
      id: m.id,
      conditionId: m.conditionId,
      slug: m.slug,
      question: m.question,
      description: m.description?.substring(0, 200),
      category: m.category,
      outcomes: m.outcomes,
      outcomePrices: m.outcomePrices,
      volume: m.volumeNum,
      volume24hr: m.volume24hr,
      liquidity: m.liquidityNum,
      active: m.active,
      closed: m.closed,
      endDate: m.endDate,
      daysUntilEnd: m.daysUntilEnd,
      lastTradePrice: m.lastTradePrice,
      bestBid: m.bestBid,
      bestAsk: m.bestAsk,
      oneDayPriceChange: m.oneDayPriceChange,
      image: m.image,
    })),
    totalFound: markets.length,
    queryParams: { keywords: input.keywords, activeOnly: input.activeOnly },
  };
}

export const searchMarketsByKeywordTool = {
  name: 'search_markets_by_keyword',
  description: 'Search Polymarket markets by keywords. Useful for matching trending topics to prediction markets. Returns market details including odds, volume, liquidity, and price changes.',
  inputSchema: searchMarketsByKeywordSchema,
  execute: executeSearchMarketsByKeyword,
};
