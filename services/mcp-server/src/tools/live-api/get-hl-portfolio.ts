/**
 * Hyperliquid Portfolio Tool
 * Fetches 30-day PnL history and account value from Hyperliquid API
 */

import { z } from 'zod';

const HL_API_URL = 'https://api.hyperliquid.xyz/info';
const HL_RATE_LIMIT_DELAY = 100;

export const getHLPortfolioSchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
});

export type GetHLPortfolioInput = z.infer<typeof getHLPortfolioSchema>;

interface PnLDataPoint {
  timestamp: number;
  value: string;
}

interface PortfolioPeriod {
  accountValueHistory: PnLDataPoint[];
  pnlHistory: PnLDataPoint[];
  vlm: string;
}

interface HLPortfolioOutput {
  wallet: string;
  periods: {
    day: {
      pnl: number;
      accountValue: number;
      volume: number;
    };
    week: {
      pnl: number;
      accountValue: number;
      volume: number;
    };
    month: {
      pnl: number;
      accountValue: number;
      volume: number;
    };
    allTime: {
      pnl: number;
      accountValue: number;
      volume: number;
    };
  };
  pnlHistory: {
    day: Array<{ timestamp: number; pnl: number }>;
    month: Array<{ timestamp: number; pnl: number }>;
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function executeGetHLPortfolio(
  input: GetHLPortfolioInput
): Promise<HLPortfolioOutput> {
  const { walletAddress } = input;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  await sleep(HL_RATE_LIMIT_DELAY);

  const response = await fetch(HL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'portfolio',
      user: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.status}`);
  }

  const data = await response.json() as Array<[string, PortfolioPeriod]>;

  // Parse the nested array response into a map
  const periodMap = new Map<string, PortfolioPeriod>();
  for (const [periodName, periodData] of data) {
    periodMap.set(periodName, periodData);
  }

  // Helper to get latest value from history
  const getLatestPnL = (history: PnLDataPoint[]): number => {
    if (!history || history.length === 0) return 0;
    // Sum all PnL values (they're cumulative deltas)
    const lastEntry = history[history.length - 1];
    return parseFloat(lastEntry?.value || '0');
  };

  const getLatestAccountValue = (history: PnLDataPoint[]): number => {
    if (!history || history.length === 0) return 0;
    const lastEntry = history[history.length - 1];
    return parseFloat(lastEntry?.value || '0');
  };

  // Extract period data
  const dayData = periodMap.get('perpDay') || periodMap.get('day');
  const weekData = periodMap.get('perpWeek') || periodMap.get('week');
  const monthData = periodMap.get('perpMonth') || periodMap.get('month');
  const allTimeData = periodMap.get('perpAllTime') || periodMap.get('allTime');

  // Build PnL history arrays for charting
  const dayPnlHistory = (dayData?.pnlHistory || []).map(([ts, val]: any) => ({
    timestamp: typeof ts === 'number' ? ts : parseInt(ts),
    pnl: parseFloat(val || '0'),
  }));

  const monthPnlHistory = (monthData?.pnlHistory || []).map(([ts, val]: any) => ({
    timestamp: typeof ts === 'number' ? ts : parseInt(ts),
    pnl: parseFloat(val || '0'),
  }));

  return {
    wallet: walletAddress.toLowerCase(),
    periods: {
      day: {
        pnl: getLatestPnL(dayData?.pnlHistory || []),
        accountValue: getLatestAccountValue(dayData?.accountValueHistory || []),
        volume: parseFloat(dayData?.vlm || '0'),
      },
      week: {
        pnl: getLatestPnL(weekData?.pnlHistory || []),
        accountValue: getLatestAccountValue(weekData?.accountValueHistory || []),
        volume: parseFloat(weekData?.vlm || '0'),
      },
      month: {
        pnl: getLatestPnL(monthData?.pnlHistory || []),
        accountValue: getLatestAccountValue(monthData?.accountValueHistory || []),
        volume: parseFloat(monthData?.vlm || '0'),
      },
      allTime: {
        pnl: getLatestPnL(allTimeData?.pnlHistory || []),
        accountValue: getLatestAccountValue(allTimeData?.accountValueHistory || []),
        volume: parseFloat(allTimeData?.vlm || '0'),
      },
    },
    pnlHistory: {
      day: dayPnlHistory,
      month: monthPnlHistory,
    },
  };
}

export const getHLPortfolioTool = {
  name: 'get_hl_portfolio',
  description: 'Get Hyperliquid portfolio with PnL history (day/week/month/allTime). Returns account value, realized PnL, and volume for each period.',
  inputSchema: getHLPortfolioSchema,
  execute: executeGetHLPortfolio,
};
