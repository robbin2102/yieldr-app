/**
 * Live Polymarket Closed Positions Tool
 * Fetches closed positions from Polymarket API
 */

import { z } from 'zod';

const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const RATE_LIMIT_DELAY = 300; // 300ms between requests

export const getPMClosedPositionsSchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
  limit: z.number().optional().default(10).describe('Number of positions to return (default: 10, max: 100)'),
  days: z.number().optional().default(30).describe('Number of days of history (default: 30)'),
});

export type GetPMClosedPositionsInput = z.infer<typeof getPMClosedPositionsSchema>;

interface PMClosedPosition {
  conditionId: string;
  title: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
  isWin: boolean;
}

interface PMClosedPositionsOutput {
  wallet: string;
  totalClosedPositions: number;
  positions: PMClosedPosition[];
  summary: {
    totalRealizedPnl: number;
    wins: number;
    losses: number;
    winRate: number;
  };
}

// Helper for rate limiting
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function executeGetPMClosedPositions(
  input: GetPMClosedPositionsInput
): Promise<PMClosedPositionsOutput> {
  const { walletAddress, limit: inputLimit = 10, days = 30 } = input;

  // Clamp limit to max 100
  const effectiveLimit = Math.min(Math.max(inputLimit, 1), 100);

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  const now = Math.floor(Date.now() / 1000);
  const startTs = now - days * 24 * 60 * 60;

  // Fetch closed positions with pagination
  const allPositions: any[] = [];
  let offset = 0;
  const limit = 50; // API limit for closed positions

  while (true) {
    const url = `${POLYMARKET_API_BASE}/v1/closed-positions?user=${walletAddress}&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status}`);
    }

    const batch = await response.json() as any[];

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    // Filter by timestamp and add to results
    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        // Stop fetching older positions
        break;
      }
    }

    // Check if we got all positions in time range
    if (batch.length < limit || batch[batch.length - 1]?.timestamp < startTs) {
      break;
    }

    offset += limit;

    // Rate limiting
    await sleep(RATE_LIMIT_DELAY);
  }

  // Map to simplified format
  const positions: PMClosedPosition[] = allPositions.map((p: any) => {
    const realizedPnl = parseFloat(p.realizedPnl || '0');
    return {
      conditionId: p.conditionId,
      title: p.title || 'Unknown Market',
      outcome: p.outcome || 'Unknown',
      totalBought: parseFloat(p.totalBought || '0'),
      avgPrice: parseFloat(p.avgPrice || '0'),
      realizedPnl,
      timestamp: p.timestamp,
      isWin: realizedPnl > 0,
    };
  });

  // Calculate summary
  const totalRealizedPnl = positions.reduce((sum, p) => sum + p.realizedPnl, 0);
  const wins = positions.filter(p => p.isWin).length;
  const losses = positions.filter(p => !p.isWin).length;
  const winRate = positions.length > 0 ? (wins / positions.length) * 100 : 0;

  return {
    wallet: walletAddress.toLowerCase(),
    totalClosedPositions: positions.length,
    positions: positions.slice(0, effectiveLimit), // Return limited positions
    summary: {
      totalRealizedPnl,
      wins,
      losses,
      winRate,
    },
  };
}

export const getPMClosedPositionsTool = {
  name: 'get_pm_closed_positions',
  description: 'Get closed positions from Polymarket for a wallet. Returns resolved markets with realized PnL. Supports limit (default 10) and days (default 30) parameters.',
  inputSchema: getPMClosedPositionsSchema,
  execute: executeGetPMClosedPositions,
};
