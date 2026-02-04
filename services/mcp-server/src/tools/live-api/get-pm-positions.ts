/**
 * Live Polymarket Positions Tool
 * Fetches real-time positions from Polymarket API
 */

import { z } from 'zod';

const POLYMARKET_API_BASE = 'https://data-api.polymarket.com';
const RATE_LIMIT_DELAY = 300; // 300ms between requests

// Helper for rate limiting
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const getPMPositionsSchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
});

export type GetPMPositionsInput = z.infer<typeof getPMPositionsSchema>;

interface PMPosition {
  conditionId: string;
  title: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentPrice: number;
  initialValue: number;
  currentValue: number;
  pnl: number;
  pnlPercent: number;
}

interface PMPositionsOutput {
  wallet: string;
  totalPositions: number;
  positions: PMPosition[];
  summary: {
    totalValue: number;
    totalPnL: number;
    totalInitialValue: number;
  };
}

export async function executeGetPMPositions(
  input: GetPMPositionsInput
): Promise<PMPositionsOutput> {
  const { walletAddress } = input;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  // Fetch all pages of positions (API limit is 500 per call)
  const allPositions: any[] = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const url = `${POLYMARKET_API_BASE}/positions?user=${walletAddress}&limit=${limit}&offset=${offset}`;

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    allPositions.push(...data);

    if (data.length < limit) {
      break;
    }

    offset += limit;

    // Rate limiting
    await sleep(RATE_LIMIT_DELAY);
  }

  // Filter active positions (price between 0.1% and 99.9%)
  const activePositions = allPositions.filter((p: any) => {
    const curPrice = parseFloat(p.curPrice || '0');
    return curPrice >= 0.001 && curPrice <= 0.999;
  });

  // Map positions to simplified format
  const positions: PMPosition[] = activePositions.map((p: any) => {
    const size = parseFloat(p.size || '0');
    const avgPrice = parseFloat(p.avgPrice || '0');
    const curPrice = parseFloat(p.curPrice || '0');
    const initialValue = parseFloat(p.initialValue || '0');
    const currentValue = parseFloat(p.currentValue || '0');
    const pnl = parseFloat(p.cashPnl || '0');
    const pnlPercent = parseFloat(p.percentPnl || '0');

    return {
      conditionId: p.conditionId,
      title: p.title || 'Unknown Market',
      outcome: p.outcome || 'Unknown',
      size,
      avgPrice,
      currentPrice: curPrice,
      initialValue,
      currentValue,
      pnl,
      pnlPercent,
    };
  });

  // Calculate summary
  const totalValue = positions.reduce((sum, p) => sum + p.currentValue, 0);
  const totalPnL = positions.reduce((sum, p) => sum + p.pnl, 0);
  const totalInitialValue = positions.reduce((sum, p) => sum + p.initialValue, 0);

  return {
    wallet: walletAddress.toLowerCase(),
    totalPositions: positions.length,
    positions,
    summary: {
      totalValue,
      totalPnL,
      totalInitialValue,
    },
  };
}

export const getPMPositionsTool = {
  name: 'get_pm_live_positions',
  description: 'Get real-time open positions from Polymarket for a wallet address. Returns current positions with market titles, prices, and PnL.',
  inputSchema: getPMPositionsSchema,
  execute: executeGetPMPositions,
};
