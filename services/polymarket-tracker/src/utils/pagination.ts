import { createLogger } from './logger';

const logger = createLogger('Pagination');

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchAllPaginated<T>(
  fetchFn: (offset: number, limit: number) => Promise<T[]>,
  limit: number,
  delayMs: number,
  maxOffset: number = 10000
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  let page = 1;

  while (offset < maxOffset) {
    logger.debug(`Fetching page ${page} (offset: ${offset}, limit: ${limit})`);

    const batch = await fetchFn(offset, limit);

    if (batch.length === 0) {
      logger.debug(`No more results found at offset ${offset}`);
      break;
    }

    results.push(...batch);
    logger.debug(`Page ${page} returned ${batch.length} results (total: ${results.length})`);

    // Stop if we got fewer results than the limit (last page)
    if (batch.length < limit) {
      logger.debug(`Last page reached (${batch.length} < ${limit})`);
      break;
    }

    offset += limit;
    page++;

    // Add delay between requests to avoid rate limiting
    if (offset < maxOffset) {
      await sleep(delayMs);
    }
  }

  logger.success(`Pagination complete: fetched ${results.length} total results across ${page} pages`);
  return results;
}
