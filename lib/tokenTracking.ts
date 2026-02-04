import connectDB from '@/lib/mongoose';
import mongoose from 'mongoose';

// Claude Sonnet 4.5 pricing (per token)
const PRICING = {
  'claude-sonnet-4-5-20250929': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  'claude-sonnet-4-20250514': { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
  default: { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

export interface TokenUsageData {
  inputTokens: number;
  outputTokens: number;
  model: string;
  toolCalls?: { name: string; inputTokens?: number; outputTokens?: number }[];
  latencyMs?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Calculate cost in USD for a given token usage.
 */
export function calculateCost(usage: TokenUsageData): number {
  const rates = PRICING[usage.model as keyof typeof PRICING] || PRICING.default;
  return (usage.inputTokens * rates.input) + (usage.outputTokens * rates.output);
}

/**
 * Update a ChatSession document with token usage for the latest message exchange.
 */
export async function updateSessionTokens(
  sessionId: string,
  usage: TokenUsageData,
): Promise<void> {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return;

    const cost = calculateCost(usage);

    await db.collection('chatSessions').updateOne(
      { _id: new mongoose.Types.ObjectId(sessionId) },
      {
        $inc: {
          'tokenUsage.totalInputTokens': usage.inputTokens,
          'tokenUsage.totalOutputTokens': usage.outputTokens,
          'tokenUsage.totalCost': cost,
          'tokenUsage.messageCount': 1,
        },
        $push: {
          'tokenUsage.perMessage': {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost,
            model: usage.model,
            toolCalls: usage.toolCalls || [],
            latencyMs: usage.latencyMs || 0,
            timestamp: new Date(),
          },
        } as any,
        $set: {
          'tokenUsage.lastModel': usage.model,
        },
      },
    );
  } catch (err) {
    console.error('[tokenTracking] Failed to update session tokens:', (err as Error).message);
  }
}

/**
 * Update per-user lifetime and rolling usage stats.
 */
export async function updateUserUsage(
  walletAddress: string,
  usage: TokenUsageData,
): Promise<void> {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return;

    const cost = calculateCost(usage);
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await db.collection('user_usage').updateOne(
      { walletAddress: walletAddress.toLowerCase() },
      {
        $inc: {
          'lifetime.totalInputTokens': usage.inputTokens,
          'lifetime.totalOutputTokens': usage.outputTokens,
          'lifetime.totalCost': cost,
          'lifetime.totalMessages': 1,
          'lifetime.totalToolCalls': (usage.toolCalls?.length || 0),
          [`monthly.${monthKey}.inputTokens`]: usage.inputTokens,
          [`monthly.${monthKey}.outputTokens`]: usage.outputTokens,
          [`monthly.${monthKey}.cost`]: cost,
          [`monthly.${monthKey}.messages`]: 1,
        },
        $set: {
          lastActiveAt: now,
        },
        $setOnInsert: {
          walletAddress: walletAddress.toLowerCase(),
          createdAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error('[tokenTracking] Failed to update user usage:', (err as Error).message);
  }
}

/**
 * Log hourly aggregated usage for analytics.
 */
export async function logHourlyUsage(
  walletAddress: string,
  usage: TokenUsageData,
  endpoint: string,
): Promise<void> {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) return;

    const now = new Date();
    const hourKey = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    const cost = calculateCost(usage);

    await db.collection('token_usage').updateOne(
      { hour: hourKey, walletAddress: walletAddress.toLowerCase(), endpoint },
      {
        $inc: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost,
          requestCount: 1,
          toolCalls: (usage.toolCalls?.length || 0),
        },
        $set: {
          model: usage.model,
          updatedAt: now,
        },
        $setOnInsert: {
          hour: hourKey,
          walletAddress: walletAddress.toLowerCase(),
          endpoint,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  } catch (err) {
    console.error('[tokenTracking] Failed to log hourly usage:', (err as Error).message);
  }
}

/**
 * Track all usage in one call (session + user + hourly).
 */
export async function trackUsage(params: {
  sessionId?: string;
  walletAddress: string;
  usage: TokenUsageData;
  endpoint: string;
}): Promise<void> {
  const { sessionId, walletAddress, usage, endpoint } = params;
  const promises: Promise<void>[] = [
    updateUserUsage(walletAddress, usage),
    logHourlyUsage(walletAddress, usage, endpoint),
  ];
  if (sessionId) {
    promises.push(updateSessionTokens(sessionId, usage));
  }
  await Promise.allSettled(promises);
}
