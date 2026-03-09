/**
 * Polymarket Market Data Tool
 * Fetches market details, odds, and metadata from Polymarket Gamma API
 */

import { z } from 'zod';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8000;

export const getPMMarketSchema = z.object({
  slug: z.string().optional().describe('Market slug (e.g. "will-israel-attack-iran-in-2025")'),
  conditionId: z.string().optional().describe('Market condition ID (0x hex string)'),
  keyword: z.string().optional().describe('Search keyword to find markets by title (e.g. "bitcoin", "trump", "taiwan")'),
  limit: z.number().optional().default(5).describe('Number of markets to return for keyword search (default: 5, max: 20)'),
  activeOnly: z.boolean().optional().default(true).describe('Only return active/open markets (default: true)'),
});

export type GetPMMarketInput = z.infer<typeof getPMMarketSchema>;

interface PMMarketOutcome {
  name: string;
  price: number;
  probability: number;
}

interface PMMarketData {
  conditionId: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  volume: number;
  volumeNum: number;
  liquidity: number;
  liquidityNum: number;
  outcomes: PMMarketOutcome[];
  url: string;
}

interface PMMarketOutput {
  totalFound: number;
  markets: PMMarketData[];
}

function parseOutcomes(market: any): PMMarketOutcome[] {
  try {
    const names: string[] = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : (market.outcomes ?? []);
    const prices: number[] = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : (market.outcomePrices ?? []);
    return names.map((name, i) => ({
      name,
      price: prices[i] ?? 0,
      probability: Math.round((prices[i] ?? 0) * 100),
    }));
  } catch {
    return [];
  }
}

function mapMarket(m: any): PMMarketData {
  return {
    conditionId: m.conditionId ?? m.condition_id ?? '',
    slug: m.slug ?? '',
    title: m.question ?? m.title ?? 'Unknown',
    description: m.description ?? '',
    category: m.category ?? '',
    endDate: m.endDate ?? m.end_date_iso ?? null,
    active: m.active ?? false,
    closed: m.closed ?? false,
    volume: parseFloat(m.volume ?? '0'),
    volumeNum: parseFloat(m.volumeNum ?? m.volume ?? '0'),
    liquidity: parseFloat(m.liquidity ?? '0'),
    liquidityNum: parseFloat(m.liquidityNum ?? m.liquidity ?? '0'),
    outcomes: parseOutcomes(m),
    url: m.slug ? `https://polymarket.com/event/${m.slug}` : '',
  };
}

export async function executeGetPMMarket(input: GetPMMarketInput): Promise<PMMarketOutput> {
  const { slug, conditionId, keyword, limit = 5, activeOnly = true } = input;

  if (!slug && !conditionId && !keyword) {
    throw new Error('Provide slug, conditionId, or keyword');
  }

  const effectiveLimit = Math.min(Math.max(limit, 1), 20);

  // ── Single market by slug or conditionId ────────────────────────────────────
  if (slug || conditionId) {
    const param = conditionId
      ? `condition_id=${encodeURIComponent(conditionId)}`
      : `slug=${encodeURIComponent(slug!)}`;

    const res = await fetch(`${GAMMA_API_BASE}/markets?${param}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Polymarket Gamma API error: ${res.status}`);

    const data = await res.json();
    const markets = Array.isArray(data) ? data : [data];

    return {
      totalFound: markets.length,
      markets: markets.map(mapMarket),
    };
  }

  // ── Keyword search ──────────────────────────────────────────────────────────
  const params = new URLSearchParams({
    _q: keyword!,
    limit: String(effectiveLimit),
    ...(activeOnly ? { active: 'true', closed: 'false' } : {}),
    order: 'volume',
    ascending: 'false',
  });

  const res = await fetch(`${GAMMA_API_BASE}/markets?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`Polymarket Gamma API error: ${res.status}`);

  const data = await res.json();
  const markets = Array.isArray(data) ? data : [];

  return {
    totalFound: markets.length,
    markets: markets.map(mapMarket),
  };
}

export const getPMMarketTool = {
  name: 'get_pm_market',
  description:
    'Fetch Polymarket market data including title, outcomes, current odds/prices, volume, and liquidity. ' +
    'Look up by slug, conditionId, or keyword search. Useful for checking current market odds on any event.',
  inputSchema: getPMMarketSchema,
  execute: executeGetPMMarket,
};
