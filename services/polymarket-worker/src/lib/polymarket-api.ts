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

  console.log(
    `[API] fetchActivitiesSince wallet=${wallet} sinceTimestamp=${sinceTimestamp} (${new Date(sinceTimestamp * 1000).toISOString()}) limit=${limit}`
  );
  console.log(`[API] Fetching URL: ${url}`);

  const fetchStart = Date.now();
  const response = await fetch(url);
  const fetchMs = Date.now() - fetchStart;

  if (!response.ok) {
    console.error(`[API] HTTP error ${response.status} for ${url} (${fetchMs}ms)`);
    throw new Error(`API error: ${response.status}`);
  }

  const activities = await response.json() as Activity[];

  console.log(
    `[API] Received ${activities.length}/${limit} activities in ${fetchMs}ms` +
    (activities.length > 0
      ? ` | timestamps: ${new Date(activities[activities.length - 1].timestamp * 1000).toISOString()} → ${new Date(activities[0].timestamp * 1000).toISOString()}`
      : '')
  );

  // WARN: if the API returned exactly `limit` items, earlier trades in the window may have been truncated
  if (activities.length === limit) {
    console.warn(
      `[API] WARNING: fetchActivitiesSince hit the limit cap (${limit}) for wallet=${wallet}. ` +
      `Trades before ${new Date(activities[activities.length - 1].timestamp * 1000).toISOString()} may be MISSING. ` +
      `Consider adding a start= time param or increasing the limit.`
    );
  }

  // Filter to only activities after the timestamp
  const filtered = activities.filter(a => a.timestamp > sinceTimestamp);
  const dropped = activities.length - filtered.length;

  if (dropped > 0) {
    console.log(`[API] Filtered out ${dropped} activities with timestamp <= sinceTimestamp (${sinceTimestamp})`);
  }
  if (filtered.length === 0 && activities.length > 0) {
    console.warn(
      `[API] All ${activities.length} fetched activities are older than sinceTimestamp=${sinceTimestamp}. ` +
      `Oldest fetched: ${new Date(activities[activities.length - 1].timestamp * 1000).toISOString()}`
    );
  }

  console.log(`[API] Returning ${filtered.length} new activities for wallet=${wallet}`);
  return filtered;
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
