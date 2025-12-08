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
  endTime?: number,
  aggregateByTime: boolean = true
): Promise<HyperliquidFillResponse[]> {
  const payload: any = {
    type: 'userFillsByTime',
    user: walletAddress,
    startTime,
    aggregateByTime
  };

  if (endTime) {
    payload.endTime = endTime;
  }

  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload)
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
  console.log(`🌐 [API] Calling Hyperliquid API: ${HYPERLIQUID_API_URL}`);
  console.log(`🌐 [API] Request: clearinghouseState for ${walletAddress}`);

  const payload = {
    type: 'clearinghouseState',
    user: walletAddress
  };

  const fetchStart = Date.now();
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload)
  });
  const fetchDuration = Date.now() - fetchStart;
  console.log(`🌐 [API] Hyperliquid API responded in ${fetchDuration}ms with status ${response.status}`);

  if (!response.ok) {
    console.error(`🔴 [API] Hyperliquid API error: ${response.status} ${response.statusText}`);
    throw new Error(`Hyperliquid API error: ${response.statusText}`);
  }

  const jsonStart = Date.now();
  const data = await response.json();
  console.log(`🌐 [API] JSON parsing took ${Date.now() - jsonStart}ms`);
  console.log(`🌐 [API] Response summary: ${data.assetPositions?.length || 0} positions, account value: $${data.marginSummary?.accountValue || 'N/A'}`);

  return data;
}

/**
 * Fetch portfolio data with PnL history for 1d/7d/30d/allTime
 */
export async function getPortfolio(
  walletAddress: string
): Promise<HyperliquidPortfolio> {
  console.log(`🌐 [API] Calling Hyperliquid Portfolio API for ${walletAddress}`);

  const payload = {
    type: 'portfolio',
    user: walletAddress
  };

  const fetchStart = Date.now();
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload)
  });
  const fetchDuration = Date.now() - fetchStart;
  console.log(`🌐 [API] Portfolio API responded in ${fetchDuration}ms with status ${response.status}`);

  if (!response.ok) {
    console.error(`🔴 [API] Portfolio API error: ${response.status} ${response.statusText}`);
    throw new Error(`Hyperliquid Portfolio API error: ${response.statusText}`);
  }

  const rawData = await response.json();

  // Transform array response to structured object
  const portfolio: HyperliquidPortfolio = {
    day: rawData[0][1],
    week: rawData[1][1],
    month: rawData[2][1],
    allTime: rawData[3][1]
  };

  // Extract latest PnL values
  const pnl_1d = portfolio.day.pnlHistory[portfolio.day.pnlHistory.length - 1]?.[1] || '0';
  const pnl_7d = portfolio.week.pnlHistory[portfolio.week.pnlHistory.length - 1]?.[1] || '0';
  const pnl_30d = portfolio.month.pnlHistory[portfolio.month.pnlHistory.length - 1]?.[1] || '0';
  const pnl_allTime = portfolio.allTime.pnlHistory[portfolio.allTime.pnlHistory.length - 1]?.[1] || '0';

  console.log(`🌐 [API] Portfolio PnL - 1d: $${pnl_1d}, 7d: $${pnl_7d}, 30d: $${pnl_30d}, All: $${pnl_allTime}`);

  return portfolio;
}

/**
 * Fetch fills in 30-day chunks with pagination (max 2000 per request)
 * Returns all fills up to 10k limit
 */
export async function getUserFills30Days(
  walletAddress: string
): Promise<HyperliquidFillResponse[]> {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const allFills: HyperliquidFillResponse[] = [];
  let currentStart = thirtyDaysAgo;
  const batchSize = 7 * 24 * 60 * 60 * 1000; // 7 days per batch

  while (currentStart < now && allFills.length < 10000) {
    const currentEnd = Math.min(currentStart + batchSize, now);

    try {
      const fills = await getUserFills(walletAddress, currentStart, currentEnd);
      allFills.push(...fills);

      // If we got less than 2000, we've fetched all available
      if (fills.length < 2000) {
        break;
      }

      currentStart = currentEnd;
    } catch (error) {
      console.error(`Error fetching fills from ${currentStart} to ${currentEnd}:`, error);
      break;
    }
  }

  return allFills;
}
