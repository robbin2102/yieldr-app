/**
 * Live Hyperliquid Positions Tool
 * Fetches real-time positions from Hyperliquid API
 */

import { z } from 'zod';

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

export const getHLPositionsSchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
});

export type GetHLPositionsInput = z.infer<typeof getHLPositionsSchema>;

interface HLPosition {
  coin: string;
  side: 'LONG' | 'SHORT';
  size: number;
  entryPrice: number;
  currentPrice: number;
  leverage: number;
  unrealizedPnl: number;
  roi: number;
  liquidationPrice: number | null;
  marginUsed: number;
}

interface HLPositionsOutput {
  wallet: string;
  totalPositions: number;
  positions: HLPosition[];
  summary: {
    totalUnrealizedPnl: number;
    totalMargin: number;
    accountValue: number;
    withdrawable: number;
  };
}

export async function executeGetHLPositions(
  input: GetHLPositionsInput
): Promise<HLPositionsOutput> {
  const { walletAddress } = input;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  // Fetch from Hyperliquid API
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'clearinghouseState',
      user: walletAddress,
    }),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.status}`);
  }

  const data = await response.json() as {
    assetPositions?: any[];
    marginSummary?: { accountValue?: string };
    withdrawable?: string;
  };
  const assetPositions = data.assetPositions || [];

  // Map positions to simplified format
  const positions: HLPosition[] = assetPositions.map((ap: any) => {
    const pos = ap.position;
    const szi = parseFloat(pos.szi);
    const entryPrice = parseFloat(pos.entryPx);
    const unrealizedPnl = parseFloat(pos.unrealizedPnl);
    const marginUsed = parseFloat(pos.marginUsed);
    const size = Math.abs(szi);
    const side: 'LONG' | 'SHORT' = szi > 0 ? 'LONG' : 'SHORT';

    // Calculate current price from PnL
    let currentPrice = entryPrice;
    if (size > 0) {
      currentPrice = side === 'LONG'
        ? entryPrice + (unrealizedPnl / size)
        : entryPrice - (unrealizedPnl / size);
    }

    const roi = marginUsed > 0 ? (unrealizedPnl / marginUsed) * 100 : 0;

    return {
      coin: pos.coin,
      side,
      size,
      entryPrice,
      currentPrice,
      leverage: pos.leverage?.value || 1,
      unrealizedPnl,
      roi,
      liquidationPrice: pos.liquidationPx ? parseFloat(pos.liquidationPx) : null,
      marginUsed,
    };
  });

  // Calculate summary
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const totalMargin = positions.reduce((sum, p) => sum + p.marginUsed, 0);
  const accountValue = parseFloat(data.marginSummary?.accountValue || '0');
  const withdrawable = parseFloat(data.withdrawable || '0');

  return {
    wallet: walletAddress.toLowerCase(),
    totalPositions: positions.length,
    positions,
    summary: {
      totalUnrealizedPnl,
      totalMargin,
      accountValue,
      withdrawable,
    },
  };
}

export const getHLPositionsTool = {
  name: 'get_hl_live_positions',
  description: 'Get real-time open positions from Hyperliquid for a wallet address. Returns current positions with PnL, leverage, and liquidation prices.',
  inputSchema: getHLPositionsSchema,
  execute: executeGetHLPositions,
};
