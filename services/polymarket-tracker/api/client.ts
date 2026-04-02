/**
 * Polymarket API Client
 * Handles HTTP requests with rate limiting
 */

import axios from 'axios';
import { CONFIG } from '../config';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/pagination';

const logger = createLogger('API Client');

/**
 * Fetch data from Polymarket API with rate limiting
 */
export async function fetchWithDelay<T>(
  url: string,
  delayMs: number = CONFIG.API_DELAY_MS
): Promise<T> {
  try {
    // Add delay before request
    await sleep(delayMs);

    logger.debug(`Fetching: ${url}`);

    const fetchStart = Date.now();
    const response = await axios.get<T>(url, {
      timeout: 30000, // 30 second timeout
      headers: {
        'Accept': 'application/json',
      },
    });
    const fetchMs = Date.now() - fetchStart;

    const dataLength = Array.isArray(response.data) ? (response.data as unknown[]).length : 1;
    logger.debug(`Response: ${response.status} | items=${dataLength} | ${fetchMs}ms | url=${url}`);

    return response.data;
  } catch (error: any) {
    if (error.response) {
      logger.error(
        `API error: ${error.response.status} - ${error.response.statusText} | url=${url}` +
        (error.response.data ? ` | body=${JSON.stringify(error.response.data).substring(0, 200)}` : '')
      );
      throw new Error(
        `Polymarket API error: ${error.response.status} - ${error.response.statusText} | url=${url}`
      );
    } else if (error.request) {
      logger.error(`No response from API | url=${url} | code=${error.code ?? 'unknown'}`);
      throw new Error(`No response from Polymarket API | url=${url}`);
    } else {
      logger.error(`Request error: ${error.message} | url=${url}`);
      throw error;
    }
  }
}

/**
 * Build URL with query parameters
 */
export function buildUrl(
  endpoint: string,
  params: Record<string, string | number | undefined>
): string {
  const url = new URL(`${CONFIG.API_BASE}${endpoint}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, String(value));
    }
  });

  return url.toString();
}
