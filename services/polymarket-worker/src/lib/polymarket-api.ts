/**
 * Polymarket Data API utilities
 */

const API_BASE = 'https://data-api.polymarket.com';

export interface Activity {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  type: 'TRADE' | 'REDEEM' | 'SPLIT' | 'MERGE' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  timestamp: number;
  transactionHash: string;
}

export interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
}

export interface ClosedPosition {
  conditionId: string;
  asset: string;
  title: string;
  slug?: string;
  outcome: string;
  totalBought: number;
  avgPrice: number;
  realizedPnl: number;
  timestamp: number;
}

/**
 * Fetch activities for a wallet since a given timestamp
 */
export async function fetchActivitiesSince(
  wallet: string,
  sinceTimestamp: number,
  limit: number = 100
): Promise<Activity[]> {
  const url = `${API_BASE}/activity?user=${wallet}&limit=${limit}&sortBy=TIMESTAMP&sortDirection=DESC`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const activities = await response.json() as Activity[];

  // Filter to only activities after the timestamp
  return activities.filter(a => a.timestamp > sinceTimestamp);
}

/**
 * Fetch all activities for a wallet within a time period
 */
export async function fetchActivities(
  wallet: string,
  days: number
): Promise<Activity[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);
  const MAX_ACTIVITIES = 2000;

  let allActivities: Activity[] = [];
  let offset = 0;

  while (allActivities.length < MAX_ACTIVITIES) {
    const url = `${API_BASE}/activity?user=${wallet}&limit=500&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as Activity[];
    if (batch.length === 0) break;

    for (const activity of batch) {
      if (activity.timestamp >= startTs) {
        allActivities.push(activity);
      } else {
        return allActivities;
      }
    }

    if (batch.length < 500) break;
    offset += 500;
    await new Promise(r => setTimeout(r, 100));
  }

  return allActivities;
}

/**
 * Fetch open positions for a wallet WITH PAGINATION
 */
export async function fetchOpenPositions(wallet: string): Promise<OpenPosition[]> {
  const LIMIT = 500;
  const MAX_OFFSET = 10000;

  let allPositions: OpenPosition[] = [];
  let offset = 0;

  while (offset <= MAX_OFFSET) {
    const url = `${API_BASE}/positions?user=${wallet}&sizeThreshold=0.1&limit=${LIMIT}&offset=${offset}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const batch = await response.json() as OpenPosition[];
    if (batch.length === 0) break;

    allPositions = allPositions.concat(batch);

    if (batch.length < LIMIT) break; // Last page
    offset += LIMIT;

    await new Promise(r => setTimeout(r, 50)); // Rate limiting
  }

  return allPositions;
}

/**
 * Fetch closed positions for a wallet
 */
export async function fetchClosedPositions(
  wallet: string,
  days: number
): Promise<ClosedPosition[]> {
  const now = Math.floor(Date.now() / 1000);
  const startTs = now - (days * 24 * 60 * 60);

  let allPositions: ClosedPosition[] = [];
  let offset = 0;

  while (true) {
    const url = `${API_BASE}/v1/closed-positions?user=${wallet}&limit=50&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const batch = await response.json() as ClosedPosition[];
    if (batch.length === 0) break;

    for (const pos of batch) {
      if (pos.timestamp >= startTs) {
        allPositions.push(pos);
      } else {
        return allPositions;
      }
    }

    if (batch.length < 50) break;
    offset += 50;
    await new Promise(r => setTimeout(r, 100));
  }

  return allPositions;
}
