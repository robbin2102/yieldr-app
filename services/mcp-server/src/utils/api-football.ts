/**
 * API-Football HTTP Client
 * Wraps https://v3.football.api-sports.io with auth, timeout, and error handling.
 */

import { logger } from './logger.js';

const API_FOOTBALL_BASE = process.env.API_FOOTBALL_BASE_URL || 'https://v3.football.api-sports.io';
const FETCH_TIMEOUT_MS = 15_000;

export interface ApiFootballResponse<T = any> {
  ok: boolean;
  data: T | null;
  errors?: string[];
  results?: number;
  paging?: { current: number; total: number };
}

/**
 * Generic GET request to API-Football.
 * Returns parsed response body or null on error.
 */
export async function apiFootballGet<T = any>(
  endpoint: string,
  params: Record<string, string | number | undefined> = {},
): Promise<ApiFootballResponse<T>> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    return { ok: false, data: null, errors: ['API_FOOTBALL_KEY not configured'] };
  }

  // Build query string, filtering out undefined values
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }

  const url = `${API_FOOTBALL_BASE}/${endpoint}?${qs.toString()}`;
  logger.info(`[api-football] GET ${endpoint}?${qs.toString()}`);

  try {
    const res = await fetch(url, {
      headers: {
        'x-apisports-key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(`[api-football] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, data: null, errors: [`HTTP ${res.status}`] };
    }

    const json = await res.json();

    // API-Football wraps responses in { get, parameters, errors, results, paging, response }
    if (json.errors && Object.keys(json.errors).length > 0) {
      const errMsgs = Object.values(json.errors) as string[];
      logger.error(`[api-football] API errors: ${errMsgs.join(', ')}`);
      return { ok: false, data: null, errors: errMsgs };
    }

    return {
      ok: true,
      data: json.response ?? json,
      results: json.results ?? 0,
      paging: json.paging,
    };
  } catch (err: any) {
    logger.error(`[api-football] Fetch error: ${err.message}`);
    return { ok: false, data: null, errors: [err.message] };
  }
}
