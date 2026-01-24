/**
 * Hyperliquid API Client
 *
 * API Documentation: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

export interface HyperliquidFillResponse {
  tid: number;
  oid: number;
  coin: string;
  side: 'B' | 'A';
  dir: string;
  px: string;
  sz: string;
  startPosition: string;
  closedPnl: string;
  fee: string;
  feeToken: string;
  builderFee?: string;
  crossed: boolean;
  hash: string;
  time: number;
}

export interface HyperliquidPosition {
  coin: string;
  cumFunding: {
    allTime: string;
    sinceChange: string;
    sinceOpen: string;
  };
  entryPx: string;
  leverage: {
    rawUsd: string;
    type: string;
    value: number;
  };
  liquidationPx: string;
  marginUsed: string;
  maxLeverage: number;
  positionValue: string;
  returnOnEquity: string;
  szi: string;
  unrealizedPnl: string;
}

export interface HyperliquidClearinghouseState {
  assetPositions: Array<{
    position: HyperliquidPosition;
    type: string;
  }>;
  crossMaintenanceMarginUsed: string;
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  time: number;
  withdrawable: string;
}

export interface HyperliquidPortfolio {
  day: {
    pnlHistory: Array<[number, string]>;
    accountValueHistory: Array<[number, string]>;
    vlm: string;
  };
  week: {
    pnlHistory: Array<[number, string]>;
    accountValueHistory: Array<[number, string]>;
  };
  month: {
    pnlHistory: Array<[number, string]>;
    accountValueHistory: Array<[number, string]>;
  };
  allTime: {
    pnlHistory: Array<[number, string]>;
    accountValueHistory: Array<[number, string]>;
  };
}

/**
 * Fetch user fills (trades) by time range
 * Max 2000 fills per response, 10000 most recent available
 */
export async function getUserFills(
  walletAddress: string,
  startTime: number,
  endTime?: number
): Promise<HyperliquidFillResponse[]> {
  const payload: any = {
    type: 'userFillsByTime',
    user: walletAddress,
    startTime,
  };

  if (endTime) {
    payload.endTime = endTime;
  }

  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch user's perpetuals account summary (open positions, margin, etc)
 */
export async function getClearinghouseState(
  walletAddress: string
): Promise<HyperliquidClearinghouseState> {
  const payload = {
    type: 'clearinghouseState',
    user: walletAddress,
  };

  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API error: ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Fetch portfolio data with PnL history for 1d/7d/30d/allTime
 */
export async function getPortfolio(
  walletAddress: string
): Promise<HyperliquidPortfolio> {
  const payload = {
    type: 'portfolio',
    user: walletAddress,
  };

  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid Portfolio API error: ${response.statusText}`);
  }

  const rawData = await response.json();

  // Transform array response to structured object
  const portfolio: HyperliquidPortfolio = {
    day: rawData[0][1],
    week: rawData[1][1],
    month: rawData[2][1],
    allTime: rawData[3][1],
  };

  return portfolio;
}

/**
 * Fetch fills in 30-day chunks with pagination (max 2000 per request)
 */
export async function getUserFills30Days(
  walletAddress: string
): Promise<HyperliquidFillResponse[]> {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Single call for 30 days (API returns up to 2000)
  const fills = await getUserFills(walletAddress, thirtyDaysAgo);
  return fills;
}
