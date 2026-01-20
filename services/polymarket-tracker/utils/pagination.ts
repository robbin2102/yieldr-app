/**
 * Pagination utility for Polymarket API
 */

import { CONFIG } from '../config';

/**
 * Sleep utility for rate limiting
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch all paginated data from Polymarket API
 * @param fetchPage - Function to fetch a single page
 * @param limit - Items per page
 * @param maxPages - Maximum number of pages to fetch (safety limit)
 */
export async function fetchAllPaginated<T>(
  fetchPage: (offset: number) => Promise<T[]>,
  limit: number,
  maxPages: number = 200
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  let page = 0;

  while (page < maxPages) {
    // Fetch page
    const batch = await fetchPage(offset);

    if (batch.length === 0) {
      break; // No more data
    }

    results.push(...batch);

    // If we got fewer items than the limit, we've reached the end
    if (batch.length < limit) {
      break;
    }

    // Next page
    offset += limit;
    page++;

    // Rate limiting delay between pages
    await sleep(CONFIG.API_DELAY_MS);
  }

  return results;
}

/**
 * Fetch paginated data with time filter (for closed positions)
 * Stops when we reach data older than cutoff date
 */
export async function fetchPaginatedWithTimeFilter<T extends { timestamp: number }>(
  fetchPage: (offset: number) => Promise<T[]>,
  limit: number,
  cutoffTimestamp: number,
  maxPages: number = 200
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  let page = 0;

  while (page < maxPages) {
    // Fetch page
    const batch = await fetchPage(offset);

    if (batch.length === 0) {
      break;
    }

    // Filter items within time range
    const filteredBatch = batch.filter(item => item.timestamp >= cutoffTimestamp);
    results.push(...filteredBatch);

    // If we found items older than cutoff, stop fetching
    const hasOlderItems = batch.some(item => item.timestamp < cutoffTimestamp);
    if (hasOlderItems || batch.length < limit) {
      break;
    }

    // Next page
    offset += limit;
    page++;

    // Rate limiting delay
    await sleep(CONFIG.API_DELAY_MS);
  }

  return results;
}
