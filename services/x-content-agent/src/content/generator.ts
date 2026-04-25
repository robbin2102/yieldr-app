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
import { buildEdgePositionPrompt } from './templates/edge-position';
import { buildReplyPrompt } from './templates/reply';
import * as mcp from '../lib/mcp-client';
import { getDB, COLLECTIONS } from '../lib/db';

async function logContent(post: GeneratedPost, source: 'test' | 'scheduler' = 'scheduler'): Promise<void> {
  try {
    const db = await getDB();
    await db.collection(COLLECTIONS.X_CONTENT_LOG).insertOne({
      ...post,
      source,
      generatedAt: new Date(),
    });
  } catch {
    // Non-critical — never block content generation on logging failure
  }
}

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
  source?: 'test' | 'scheduler';
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

  const post: GeneratedPost = {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'TRADER_PROFILE',
    metadata: { wallet: trader.wallet, label: trader.label, rotation: opts?.rotation },
  };
  await logContent(post, opts?.source || 'scheduler');
  return post;
}

/**
 * Generate a High Conviction / Edge Position post
 *
 * Primary source: edge-ranked trader open positions (polymarket-traderPositions)
 * filtered by category. Scores by percentPnl × cashPnl to surface the most
 * compelling live positions. Rotates through NBA / Soccer / Politics per window.
 *
 * Fallback chain (if no positions found for category):
 *   1. Unfiltered edge positions
 *   2. Copy trade activity
 *   3. Materialized HC trades
 */
export async function generateHighConvictionAlert(category?: string, source: 'test' | 'scheduler' = 'scheduler'): Promise<GeneratedPost> {
  // Primary: edge trader open positions (fresh, category-rotatable, no repetition)
  let positionData = await mcp.getEdgeTraderPositions({
    category,
    limit: 10,
    minPercentPnl: 5,
  });

  let positions = positionData.positions || [];

  // Fallback 1: try without category filter
  if (positions.length === 0 && category) {
    positionData = await mcp.getEdgeTraderPositions({ limit: 10, minPercentPnl: 5 });
    positions = positionData.positions || [];
  }

  // Fallback 2: lower the bar — any profitable position
  if (positions.length === 0) {
    positionData = await mcp.getEdgeTraderPositions({ category, limit: 10 });
    positions = positionData.positions || [];
  }

  if (positions.length > 0) {
    // Pick top-scored position
    const position = positions[0];
    const prompt = buildEdgePositionPrompt(position);
    const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });

    const post: GeneratedPost = {
      type: result.type || 'post',
      tweet: result.tweet || result.content,
      telegram: result.telegram || '',
      category: 'HIGH_CONVICTION',
      metadata: {
        traderWallet: position.traderWallet,
        market: position.title,
        percentPnl: position.percentPnl,
        positionCategory: category || 'all',
      },
    };
    await logContent(post, source);
    return post;
  }

  // Fallback 3: copy trade activity (old path)
  const copyData = await mcp.getCopyTradeActivity({ hours: 72, limit: 5 });
  let trades = copyData.trades || [];

  if (trades.length === 0) {
    const hcData = await mcp.getHighConvictionTrades({ convictionLevel: 'ALL', hours: 168, limit: 5 });
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

  if (trades.length === 0) throw new Error('No edge positions or copy trades found');

  const trade = trades.sort((a: any, b: any) => (b.convictionRatio || 0) - (a.convictionRatio || 0))[0];
  const prompt = buildHighConvictionPrompt(trade);
  const result = await generateStructuredContent(YIELDR_AGENT_SYSTEM_PROMPT, prompt, { temperature: 0.85 });

  const post: GeneratedPost = {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'HIGH_CONVICTION',
    metadata: { traderWallet: trade.traderWallet, market: trade.market, convictionRatio: trade.convictionRatio },
  };
  await logContent(post, source);
  return post;
}

/**
 * Generate a Vault Performance post with agent analysis
 */
export async function generateVaultPerformance(vaultName?: string, source: 'test' | 'scheduler' = 'scheduler'): Promise<GeneratedPost> {
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

  const post: GeneratedPost = {
    type: result.type || 'post',
    tweet: result.tweet || result.content,
    telegram: result.telegram || '',
    category: 'VAULT_PERFORMANCE',
    metadata: { vaultName: vault.name },
  };
  await logContent(post, source);
  return post;
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
