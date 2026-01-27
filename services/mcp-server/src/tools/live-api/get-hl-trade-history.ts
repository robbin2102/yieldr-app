/**
 * Live Hyperliquid Trade History Tool
 * Fetches recent trades/fills from Hyperliquid API
 *
 * Rate limits: 1200 weight/minute, userFillsByTime = weight 20 + 1 per 20 items
 */

import { z } from 'zod';

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

// Rate limit: Higher delay for fills (weight 20+)
const HL_FILLS_RATE_LIMIT_DELAY = 500;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const getHLTradeHistorySchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
  limit: z.number().optional().default(10).describe('Number of trades to return (default: 10, max: 100)'),
  startTime: z.number().optional().describe('Start timestamp in ms (optional, defaults to 7 days ago)'),
  endTime: z.number().optional().describe('End timestamp in ms (optional, defaults to now)'),
});

export type GetHLTradeHistoryInput = z.infer<typeof getHLTradeHistorySchema>;

interface HLTrade {
  coin: string;
  side: 'BUY' | 'SELL';
  direction: string;
  price: number;
  size: number;
  closedPnl: number;
  fee: number;
  timestamp: number;
  hash: string;
}

interface HLTradeHistoryOutput {
  wallet: string;
  totalTrades: number;
  trades: HLTrade[];
  summary: {
    totalRealizedPnl: number;
    totalFees: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
  };
}

export async function executeGetHLTradeHistory(
  input: GetHLTradeHistoryInput
): Promise<HLTradeHistoryOutput> {
  const { walletAddress, limit = 10, startTime: inputStartTime, endTime: inputEndTime } = input;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  // Calculate time range (default: last 7 days)
  const now = Date.now();
  const startTime = inputStartTime ?? (now - 7 * 24 * 60 * 60 * 1000);
  const endTime = inputEndTime ?? now;

  // Clamp limit to max 100
  const effectiveLimit = Math.min(Math.max(limit, 1), 100);

  // Build request payload
  const payload: any = {
    type: 'userFillsByTime',
    user: walletAddress,
    startTime,
  };
  if (inputEndTime) {
    payload.endTime = endTime;
  }

  // Fetch fills from Hyperliquid API
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.status}`);
  }

  // Rate limit delay after request (high weight due to response size)
  await sleep(HL_FILLS_RATE_LIMIT_DELAY);

  const fills = await response.json() as any[];

  // Map fills to simplified trade format
  const trades: HLTrade[] = fills.map((fill: any) => ({
    coin: fill.coin,
    side: fill.side === 'B' ? 'BUY' : 'SELL',
    direction: fill.dir,
    price: parseFloat(fill.px),
    size: parseFloat(fill.sz),
    closedPnl: parseFloat(fill.closedPnl || '0'),
    fee: parseFloat(fill.fee || '0'),
    timestamp: fill.time,
    hash: fill.hash,
  }));

  // Calculate summary
  const totalRealizedPnl = trades.reduce((sum, t) => sum + t.closedPnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fee, 0);

  // Count winning/losing trades (only trades with closedPnl)
  const tradesWithPnl = trades.filter(t => t.closedPnl !== 0);
  const winningTrades = tradesWithPnl.filter(t => t.closedPnl > 0).length;
  const losingTrades = tradesWithPnl.filter(t => t.closedPnl < 0).length;
  const winRate = tradesWithPnl.length > 0
    ? (winningTrades / tradesWithPnl.length) * 100
    : 0;

  return {
    wallet: walletAddress.toLowerCase(),
    totalTrades: trades.length,
    trades: trades.slice(0, effectiveLimit), // Return limited trades
    summary: {
      totalRealizedPnl,
      totalFees,
      winningTrades,
      losingTrades,
      winRate,
    },
  };
}

export const getHLTradeHistoryTool = {
  name: 'get_hl_trade_history',
  description: 'Get recent trade history from Hyperliquid for a wallet. Returns fills with realized PnL. Supports limit (default 10) and time range (startTime/endTime in ms).',
  inputSchema: getHLTradeHistorySchema,
  execute: executeGetHLTradeHistory,
};
