/**
 * Live Avantis Positions Tool
 * Fetches real-time positions from Avantis via production API
 */

import { z } from 'zod';

const AVANTIS_API_URL = 'https://yieldr-app-production.up.railway.app/fetch-positions';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

export const getAvantisPositionsSchema = z.object({
  walletAddress: z.string().describe('Ethereum wallet address (0x...)'),
});

export type GetAvantisPositionsInput = z.infer<typeof getAvantisPositionsSchema>;

interface AvantisPosition {
  pair: string;
  direction: 'LONG' | 'SHORT';
  positionSize: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  roi: number;
  liquidationPrice: number | null;
  margin: number;
  openedAt?: string;
}

interface AvantisPositionsOutput {
  wallet: string;
  totalPositions: number;
  positions: AvantisPosition[];
  summary: {
    totalPnL: number;
    totalMargin: number;
  };
}

export async function executeGetAvantisPositions(
  input: GetAvantisPositionsInput
): Promise<AvantisPositionsOutput> {
  const { walletAddress } = input;

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    throw new Error('Invalid Ethereum address format');
  }

  // Fetch from Avantis production API (with 60s timeout)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(AVANTIS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress,
        rpcUrl: BASE_RPC_URL,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Avantis API error: ${response.status}`);
    }

    const data = await response.json() as {
      success: boolean;
      error?: string;
      data?: { positions?: any[] };
    };

    if (!data.success) {
      throw new Error(data.error || 'Avantis API returned unsuccessful response');
    }

    // Map positions to simplified format
    const positions: AvantisPosition[] = (data.data?.positions || []).map((p: any) => ({
      pair: p.asset || p.pair || 'Unknown',
      direction: p.direction || (p.isLong ? 'LONG' : 'SHORT'),
      positionSize: p.positionSize || p.size || 0,
      leverage: p.leverage || 1,
      entryPrice: p.entryPrice || p.openPrice || 0,
      currentPrice: p.currentPrice || p.markPrice || 0,
      pnl: p.pnl || p.unrealizedPnl || 0,
      roi: p.roi || 0,
      liquidationPrice: p.liquidationPrice || null,
      margin: p.margin || p.collateral || 0,
      openedAt: p.openedAt || p.createdAt,
    }));

    // Calculate summary
    const totalPnL = positions.reduce((sum, p) => sum + p.pnl, 0);
    const totalMargin = positions.reduce((sum, p) => sum + p.margin, 0);

    return {
      wallet: walletAddress.toLowerCase(),
      totalPositions: positions.length,
      positions,
      summary: {
        totalPnL,
        totalMargin,
      },
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('Avantis API timeout (>60s)');
    }

    throw error;
  }
}

export const getAvantisPositionsTool = {
  name: 'get_avantis_live_positions',
  description: 'Get real-time open positions from Avantis (Base chain) for a wallet address. Returns current positions with PnL and leverage.',
  inputSchema: getAvantisPositionsSchema,
  execute: executeGetAvantisPositions,
};
