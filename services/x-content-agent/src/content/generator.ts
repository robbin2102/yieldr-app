/**
 * Content Generator
 * Orchestrates data fetching + Grok content generation for each post type
 */

import { generateStructuredContent } from '../lib/grok-client';
import { YIELDR_AGENT_SYSTEM_PROMPT } from './system-prompt';
import { buildTraderAlphaPrompt } from './templates/trader-alpha';
import { buildMarketsAlphaPrompt } from './templates/markets-alpha';
import { buildHighConvictionPrompt } from './templates/high-conviction';
import { buildVaultPerformancePrompt } from './templates/vault-performance';
import { buildBasePostingPrompt } from './templates/base-posting';
import { buildReplyPrompt } from './templates/reply';
import * as mcp from '../lib/mcp-client';

export interface GeneratedPost {
  type: 'post' | 'reply' | 'quote';
  content: string;
  category: string;
  target_post_id?: string;
  metadata?: Record<string, any>;
}

/**
 * Generate a Trader Profile Alpha post
 */
export async function generateTraderAlpha(opts?: { category?: string }): Promise<GeneratedPost> {
  const data = await mcp.getEdgeRankedTraders({
    category: opts?.category,
    sortBy: 'profitFactor',
    limit: 5,
  });

  // Pick a random trader from top 5 for variety
  const traders = data.traders || [];
  if (traders.length === 0) throw new Error('No edge-ranked traders found');

  const trader = traders[Math.floor(Math.random() * traders.length)];
  const prompt = buildTraderAlphaPrompt(trader);
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: result.type || 'post',
    content: result.content,
    category: 'TRADER_PROFILE',
    metadata: { wallet: trader.wallet, label: trader.label },
  };
}

/**
 * Generate a Markets Alpha post
 */
export async function generateMarketsAlpha(keywords?: string[]): Promise<GeneratedPost> {
  // If no keywords provided, use top volume markets
  let markets: any[] = [];
  let traderPositions: any[] = [];

  if (keywords && keywords.length > 0) {
    const marketData = await mcp.searchMarketsByKeyword(keywords, { limit: 5 });
    markets = marketData.markets || [];

    // Get trader positions in top market
    if (markets.length > 0) {
      const posData = await mcp.getTraderPositionsInMarket({
        conditionId: markets[0].conditionId,
        edgeTradersOnly: true,
      });
      traderPositions = posData.positions || [];
    }
  } else {
    // Fallback: get high-volume markets
    const marketData = await mcp.searchMarketsByKeyword([''], { limit: 5, minVolume: 100000 });
    markets = marketData.markets || [];
  }

  const prompt = buildMarketsAlphaPrompt({
    markets,
    traderPositions,
    trendKeyword: keywords?.[0],
  });

  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: result.type || 'post',
    content: result.content,
    category: 'MARKETS_ALPHA',
    metadata: { keywords, marketCount: markets.length },
  };
}

/**
 * Generate a High Conviction Trade Alert post
 */
export async function generateHighConvictionAlert(): Promise<GeneratedPost> {
  const data = await mcp.getHighConvictionTrades({
    convictionLevel: 'WHALE',
    hours: 24,
    unposted: true,
    limit: 5,
  });

  let trades = data.trades || [];

  // If no whale trades, try significant
  if (trades.length === 0) {
    const fallback = await mcp.getHighConvictionTrades({
      convictionLevel: 'SIGNIFICANT',
      hours: 24,
      unposted: true,
      limit: 5,
    });
    trades = fallback.trades || [];
  }

  if (trades.length === 0) throw new Error('No high conviction trades found');

  const trade = trades[0]; // Most recent unposted
  const prompt = buildHighConvictionPrompt(trade);
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: result.type || 'post',
    content: result.content,
    category: 'HIGH_CONVICTION',
    metadata: { transactionHash: trade.transactionHash, wallet: trade.wallet },
  };
}

/**
 * Generate a Vault Performance post
 */
export async function generateVaultPerformance(vaultName?: string): Promise<GeneratedPost> {
  const data = await mcp.getVaultPerformance({
    vaultName,
    period: '30d',
  });

  const vaults = data.vaults || [];
  if (vaults.length === 0) throw new Error('No vault data found');

  // Pick specific vault or rotate
  const vault = vaultName
    ? vaults[0]
    : vaults[Math.floor(Math.random() * vaults.length)];

  const prompt = buildVaultPerformancePrompt(vault);
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: result.type || 'post',
    content: result.content,
    category: 'VAULT_PERFORMANCE',
    metadata: { vaultName: vault.name },
  };
}

/**
 * Generate a Base Ecosystem post
 */
export async function generateBasePost(sourcePost?: {
  text: string;
  author: string;
  tweetId: string;
}): Promise<GeneratedPost> {
  const prompt = buildBasePostingPrompt({ sourcePost });
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: result.type || (sourcePost ? 'quote' : 'post'),
    content: result.content,
    category: 'BASE_POSTING',
    target_post_id: sourcePost?.tweetId,
    metadata: { sourceAuthor: sourcePost?.author },
  };
}

/**
 * Generate a reply to a mention or comment
 */
export async function generateReply(incomingTweet: {
  text: string;
  authorUsername: string;
  tweetId: string;
}): Promise<GeneratedPost> {
  // Try to fetch relevant context based on tweet content
  let context: any = {};

  try {
    // Check if asking about vaults
    if (/vault|performance|pnl|roi|return/i.test(incomingTweet.text)) {
      context.vaultData = await mcp.getVaultPerformance({ period: '30d' });
    }
    // Check if asking about traders
    if (/trader|edge|alpha|whale/i.test(incomingTweet.text)) {
      context.traderData = await mcp.getEdgeRankedTraders({ limit: 3 });
    }
  } catch {
    // Context fetch failed, reply without data
  }

  const prompt = buildReplyPrompt({ incomingTweet, context });
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt);

  return {
    type: 'reply',
    content: result.content,
    category: 'REPLY',
    target_post_id: incomingTweet.tweetId,
    metadata: { replyTo: incomingTweet.authorUsername },
  };
}
