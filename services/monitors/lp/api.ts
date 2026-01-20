/**
 * DefiKrystal API Client for LP Positions
 */

const KRYSTAL_API_URL = 'https://api.krystal.app/all/v1/lp/userPositions';
const BASE_CHAIN_ID = '8453';

export interface KrystalLPPosition {
  id: string;
  pool: {
    project?: string;
    projectKey?: string;
    address: string;
  };
  currentAmounts: Array<{
    token: {
      symbol: string;
      address: string;
    };
    balance: string;
    quotes: {
      usd: {
        value: number;
      };
    };
  }>;
  pnl: number;
  returnOnInvestment: number;
  apr: number;
  status: string;
  feePending?: Array<{
    quotes: {
      usd: {
        value: number;
      };
    };
  }>;
}

export interface KrystalResponse {
  positions: KrystalLPPosition[];
  statsByChain: {
    all?: any;
    [chainId: string]: any;
  };
}

/**
 * Fetch LP positions from DefiKrystal API
 */
export async function fetchLPPositions(walletAddress: string): Promise<KrystalResponse> {
  const normalizedAddress = walletAddress.toLowerCase();
  const url = `${KRYSTAL_API_URL}?addresses=${normalizedAddress}&chainIds=${BASE_CHAIN_ID}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; Yieldr/1.0; +https://app.yieldr.org)',
      'Origin': 'https://app.yieldr.org',
      'Referer': 'https://app.yieldr.org/'
    }
  });

  if (!response.ok) {
    throw new Error(`Krystal API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Parse Krystal position to our standardized format
 */
export function parseKrystalPosition(pos: KrystalLPPosition) {
  const token0 = pos.currentAmounts?.[0]?.token;
  const token1 = pos.currentAmounts?.[1]?.token;

  const liquidity = pos.currentAmounts?.reduce((sum: number, amount: any) => {
    return sum + (amount.quotes?.usd?.value || 0);
  }, 0) || 0;

  const platform = pos.pool?.project || pos.pool?.projectKey || 'Unknown';

  const unclaimedFees = pos.feePending?.reduce(
    (sum: number, fee: any) => sum + (fee.quotes?.usd?.value || 0),
    0
  ) || 0;

  // Calculate net PnL (PnL + fees - impermanent loss)
  // Note: Krystal's pnl already includes IL, so netPnl = pnl
  const netPnl = pos.pnl || 0;

  return {
    positionId: pos.id,
    protocol: platform,
    poolAddress: pos.pool?.address || '',
    pair: `${token0?.symbol || '?'}/${token1?.symbol || '?'}`,
    token0: {
      symbol: token0?.symbol || '',
      amount: parseFloat(pos.currentAmounts?.[0]?.balance || '0'),
      value: pos.currentAmounts?.[0]?.quotes?.usd?.value || 0,
      address: token0?.address || ''
    },
    token1: {
      symbol: token1?.symbol || '',
      amount: parseFloat(pos.currentAmounts?.[1]?.balance || '0'),
      value: pos.currentAmounts?.[1]?.quotes?.usd?.value || 0,
      address: token1?.address || ''
    },
    liquidityValue: liquidity,
    currentPnl: pos.pnl || 0,
    roi: pos.returnOnInvestment || 0,
    feesEarned: unclaimedFees, // Using unclaimed as earned for MVP
    unclaimedFees: unclaimedFees,
    impermanentLoss: 0, // Krystal doesn't separate IL
    netPnl: netPnl,
    apr: pos.apr || 0,
    status: pos.status || 'UNKNOWN'
  };
}
