/**
 * Polymarket User Activity Tool
 * Fetches trade activity for a wallet using the Polymarket data-api /activity endpoint
 *
 * API reference: GET https://data-api.polymarket.com/activity
 * Params: user (required), market, side, type, start (unix ts), end (unix ts), limit, offset, sortBy, sortDirection
 */

import { z } from 'zod';

const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8000;

export const getPMUserActivitySchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
  market: z.string().optional().describe('Filter by condition ID (0x hex) to see activity in one market'),
  side: z.enum(['BUY', 'SELL']).optional().describe('Filter by trade side: BUY or SELL'),
  type: z.enum(['TRADE', 'SPLIT', 'MERGE', 'REDEEM', 'REWARD', 'CONVERSION', 'MAKER_REBATE']).optional().describe('Filter by activity type (default: all)'),
  afterDays: z.number().optional().default(7).describe('Only return activity from the last N days (default: 7). Use 0.04 (~1h) for recent monitoring.'),
  limit: z.number().optional().default(20).describe('Number of activity records to return (default: 20, hard max: 100). Never request more than 100 — large limits destroy context and inflate costs.'),
  minValueUsd: z.number().optional().describe('Only return activities with USD value >= this threshold (e.g. 10000 for $10k+ conviction bets). Applied client-side after fetch.'),
});

export type GetPMUserActivityInput = z.infer<typeof getPMUserActivitySchema>;

interface PMActivity {
  id: string;
  type: string;
  side: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;
  size: number;
  price: number;
  value: number;
  timestamp: number;
  transactionHash: string;
}

interface PMUserActivityOutput {
  wallet: string;
  totalActivity: number;
  summary: {
    buys: number;
    sells: number;
    totalVolumeUsd: number;
    uniqueMarkets: number;
  };
  activity: PMActivity[];
}

export async function executeGetPMUserActivity(input: GetPMUserActivityInput): Promise<PMUserActivityOutput> {
  const { walletAddress, market, side, type, afterDays = 7, limit = 20, minValueUsd } = input;

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  const effectiveLimit = Math.min(Math.max(limit, 1), 100);
  const afterTs = Math.floor(Date.now() / 1000) - afterDays * 86400;

  const params = new URLSearchParams({
    user: walletAddress,
    limit: String(effectiveLimit),
    start: String(afterTs),
  });

  if (market) params.set('market', market);
  if (side) params.set('side', side);
  if (type) params.set('type', type);

  const url = `${POLYMARKET_API_BASE}/activity?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    if (res.status === 408 || res.status === 429) {
      return { wallet: walletAddress.toLowerCase(), totalActivity: 0, summary: { buys: 0, sells: 0, totalVolumeUsd: 0, uniqueMarkets: 0 }, activity: [] };
    }
    throw new Error(`Polymarket API error: ${res.status}`);
  }

  const raw = await res.json() as any;
  const records: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.activity ?? []);

  const activity: PMActivity[] = records.map((r: any) => ({
    id: r.id ?? r.transactionHash ?? '',
    type: r.type ?? 'TRADE',
    side: r.side ?? '',
    conditionId: r.conditionId ?? r.market ?? '',
    marketTitle: r.title ?? r.question ?? r.marketTitle ?? 'Unknown Market',
    outcome: r.outcome ?? r.outcomeIndex ?? '',
    size: parseFloat(r.size ?? r.shares ?? '0'),
    price: parseFloat(r.price ?? '0'),
    value: parseFloat(r.usdcSize ?? r.value ?? '0'),
    timestamp: r.timestamp ?? r.createdAt ?? 0,
    transactionHash: r.transactionHash ?? '',
  }));

  const filteredActivity = minValueUsd != null ? activity.filter(a => a.value >= minValueUsd) : activity;

  const buys = filteredActivity.filter(a => a.side === 'BUY').length;
  const sells = filteredActivity.filter(a => a.side === 'SELL').length;
  const totalVolumeUsd = filteredActivity.reduce((s, a) => s + a.value, 0);
  const uniqueMarkets = new Set(filteredActivity.map(a => a.conditionId).filter(Boolean)).size;

  return {
    wallet: walletAddress.toLowerCase(),
    totalActivity: filteredActivity.length,
    summary: { buys, sells, totalVolumeUsd, uniqueMarkets },
    activity: filteredActivity,
  };
}

export const getPMUserActivityTool = {
  name: 'get_pm_user_activity',
  description:
    'Fetch recent trade activity for a Polymarket wallet. Returns buys, sells, and redeems with market titles, prices, and sizes. ' +
    'HARD LIMIT: max 100 activities per call — never request more. Default is 20. ' +
    'For monitoring large conviction bets: set afterDays=0.04 (~1h window) and minValueUsd=10000 to surface $10k+ trades. ' +
    'Filter by market (conditionId), side (BUY/SELL), or days back.',
  inputSchema: getPMUserActivitySchema,
  execute: executeGetPMUserActivity,
};
