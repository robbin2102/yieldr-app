/**
 * Polymarket Market Data Tool
 * Fetches market details, odds, and metadata from Polymarket Gamma API
 */

import { z } from 'zod';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 8000;

export const getPMMarketSchema = z.object({
  url: z.string().optional().describe('Full Polymarket URL (e.g. "https://polymarket.com/event/us-x-iran-ceasefire-by"). Slug is extracted automatically.'),
  slug: z.string().optional().describe('Market or event slug (e.g. "will-israel-attack-iran-in-2025")'),
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

function extractSlugFromUrl(url: string): string {
  // Handles: https://polymarket.com/event/some-slug or /market/some-slug
  const match = url.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/);
  if (!match) throw new Error(`Cannot extract slug from URL: ${url}`);
  return match[1];
}

export async function executeGetPMMarket(input: GetPMMarketInput): Promise<PMMarketOutput> {
  let { url, slug, conditionId, keyword, limit = 5, activeOnly = true } = input;

  // Auto-extract slug from a pasted Polymarket URL
  if (url && !slug && !conditionId) {
    slug = extractSlugFromUrl(url);
  }

  if (!slug && !conditionId && !keyword) {
    throw new Error('Provide url, slug, conditionId, or keyword');
  }

  const effectiveLimit = Math.min(Math.max(limit, 1), 20);

  // ── Single market by conditionId ─────────────────────────────────────────────
  if (conditionId) {
    const res = await fetch(`${GAMMA_API_BASE}/markets?condition_id=${encodeURIComponent(conditionId)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Polymarket Gamma API error: ${res.status}`);
    const data = await res.json();
    const markets = Array.isArray(data) ? data : [data];
    return { totalFound: markets.length, markets: markets.map(mapMarket) };
  }

  // ── Single market/event by slug ──────────────────────────────────────────────
  if (slug) {
    // Try /markets first
    const mRes = await fetch(`${GAMMA_API_BASE}/markets?slug=${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (mRes.ok) {
      const mData = await mRes.json();
      const markets = Array.isArray(mData) ? mData.filter((m: any) => m.conditionId || m.condition_id) : [];
      if (markets.length > 0) {
        return { totalFound: markets.length, markets: markets.map(mapMarket) };
      }
    }

    // Fallback: try /events (Polymarket event URLs have event-level slugs)
    const eRes = await fetch(`${GAMMA_API_BASE}/events?slug=${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!eRes.ok) throw new Error(`Polymarket Gamma API error: ${eRes.status}`);
    const eData = await eRes.json();
    const events = Array.isArray(eData) ? eData : [eData];

    // Extract child markets from the event
    const childMarkets: any[] = events.flatMap((e: any) => {
      const ms = e.markets ?? e.series ?? [];
      return Array.isArray(ms) ? ms : [];
    });

    if (childMarkets.length > 0) {
      return { totalFound: childMarkets.length, markets: childMarkets.map(mapMarket) };
    }

    // Event itself had no nested markets — map the event as a market
    return { totalFound: events.length, markets: events.map(mapMarket) };
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
    'PREFERRED: pass the full Polymarket URL (e.g. "https://polymarket.com/event/us-x-iran-ceasefire-by") and the slug is extracted automatically. ' +
    'Also accepts slug, conditionId, or keyword search. ' +
    'Handles both /event/ and /market/ URLs — tries /markets then /events endpoint automatically. ' +
    'Useful for checking current market odds on any event.',
  inputSchema: getPMMarketSchema,
  execute: executeGetPMMarket,
};
