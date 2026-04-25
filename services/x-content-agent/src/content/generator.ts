/**
 * Content Generator
 * Orchestrates data fetching + Grok content generation for each post type
 *
 * Active content types:
 *   - TRADER_PROFILE: Narrative profiles of edge-ranked traders (daily rotation)
 *   - HIGH_CONVICTION: Live copy trade alerts from vault agents
 *   - VAULT_PERFORMANCE: Vault metrics with agent analysis
 *
 * Disabled content types:
 *   - MARKETS_ALPHA: Disabled (to be rebuilt later)
 *   - BASE_POSTING: Disabled (needs base account post fetching)
 */

import { generateStructuredContent } from '../lib/grok-client';
import { YIELDR_AGENT_SYSTEM_PROMPT } from './system-prompt';
import { buildTraderAlphaPrompt } from './templates/trader-alpha';
import { buildHighConvictionPrompt } from './templates/high-conviction';
import { buildVaultPerformancePrompt } from './templates/vault-performance';
import { buildReplyPrompt } from './templates/reply';
import * as mcp from '../lib/mcp-client';

export interface GeneratedPost {
  type: 'post' | 'reply' | 'quote';
  tweet: string;
  telegram: string;
  category: string;
  target_post_id?: string;
  metadata?: Record<string, any>;
}

/**
 * Generate a Trader Profile Alpha post
 * Supports daily rotation: pass rotation index (1-4) for series posts
 */
export async function generateTraderAlpha(opts?: {
  category?: string;
  rotation?: number;
  totalTraders?: number;
}): Promise<GeneratedPost> {
  const data = await mcp.getEdgeRankedTraders({
    category: opts?.category,
    sortBy: 'rank_score',
    limit: opts?.totalTraders || 4,
  });

  const traders = data.traders || [];
  if (traders.length === 0) throw new Error('No edge-ranked traders found');

  // Pick trader based on rotation index or random
  const traderIndex = opts?.rotation
    ? Math.min(opts.rotation - 1, traders.length - 1)
    : Math.floor(Math.random() * Math.min(3, traders.length));

  const trader = traders[traderIndex];
  const prompt = buildTraderAlphaPrompt(trader, {
    rotation: opts?.rotation,
    totalTraders: opts?.totalTraders || Math.min(4, traders.length),
  });
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });

  return {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'TRADER_PROFILE',
    metadata: { wallet: trader.wallet, label: trader.label, rotation: opts?.rotation },
  };
}

/**
 * Generate a High Conviction / Copy Trade Alert post
 * Uses live copy trade data from vault agents (FILLED trades)
 */
export async function generateHighConvictionAlert(): Promise<GeneratedPost> {
  // Try live copy trade activity first
  const copyData = await mcp.getCopyTradeActivity({
    hours: 72,
    limit: 5,
  });

  let trades = copyData.trades || [];

  // Fallback: use materialized HC trades if no copy trades available
  if (trades.length === 0) {
    const hcData = await mcp.getHighConvictionTrades({
      convictionLevel: 'ALL',
      hours: 168,
      limit: 5,
    });

    trades = (hcData.trades || []).map((t: any) => ({
      market: t.market,
      outcome: t.outcome,
      side: t.side,
      traderBetUsdc: t.usdcValue,
      traderPrice: t.price,
      convictionRatio: t.sizeMultiplier || 0,
      avgBet: t.traderContext?.avgTradeSize,
      ourExecutedSize: null,
      ourPrice: null,
      traderWinRate: t.traderContext?.winRate,
      traderProfitFactor: t.traderContext?.profitFactor,
      traderSpecialty: null,
      traderWallet: t.wallet,
      traderLabel: t.traderLabel,
    }));
  }

  // Last fallback: use edge-ranked trader's HC trades
  if (trades.length === 0) {
    const traderData = await mcp.getEdgeRankedTraders({ sortBy: 'rank_score', limit: 3 });
    const topTrader = traderData.traders?.[0];
    if (topTrader?.highConviction?.recentTrades?.length > 0) {
      const hcTrade = topTrader.highConviction.recentTrades[0];
      trades = [{
        market: hcTrade.market,
        outcome: hcTrade.outcome,
        side: hcTrade.side || 'BUY',
        traderBetUsdc: hcTrade.usdcSize,
        traderPrice: hcTrade.price,
        convictionRatio: hcTrade.sizeMultiplier || 0,
        avgBet: topTrader.metrics?.avgTradeSize,
        ourExecutedSize: null,
        ourPrice: null,
        traderWinRate: topTrader.metrics?.winRate,
        traderProfitFactor: topTrader.metrics?.profitFactor,
        traderSpecialty: topTrader.specialty,
        traderWallet: topTrader.wallet,
        traderLabel: topTrader.displayName || topTrader.label,
      }];
    }
  }

  if (trades.length === 0) throw new Error('No copy trades or high conviction trades found');

  // Pick the highest conviction trade
  const trade = trades.sort((a: any, b: any) => (b.convictionRatio || 0) - (a.convictionRatio || 0))[0];
  const prompt = buildHighConvictionPrompt(trade);
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });

  return {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'HIGH_CONVICTION',
    metadata: { traderWallet: trade.traderWallet, market: trade.market, convictionRatio: trade.convictionRatio },
  };
}

/**
 * Generate a Vault Performance post with agent analysis
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
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });

  return {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'VAULT_PERFORMANCE',
    metadata: { vaultName: vault.name },
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
  let context: any = {};

  try {
    if (/vault|performance|pnl|roi|return/i.test(incomingTweet.text)) {
      context.vaultData = await mcp.getVaultPerformance({ period: '30d' });
    }
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
    tweet: result.tweet || result.content,
    telegram: '',
    category: 'REPLY',
    target_post_id: incomingTweet.tweetId,
    metadata: { replyTo: incomingTweet.authorUsername },
  };
}
