import fetch from 'node-fetch';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { sleep } from '../utils/pagination';

const logger = createLogger('API Client');

export class PolymarketAPIClient {
  private baseUrl: string;
  private delayMs: number;

  constructor() {
    this.baseUrl = config.api.baseUrl;
    this.delayMs = config.polymarket.apiDelayMs;
  }

  /**
   * Fetch with automatic rate limiting delay
   */
  async fetchWithDelay<T>(url: string): Promise<T> {
    // Add delay before each request to respect rate limits
    await sleep(this.delayMs);

    logger.debug(`GET ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText} - ${url}`);
    }

    const data = await response.json();
    return data as T;
  }

  /**
   * Build URL with query parameters
   */
  buildUrl(endpoint: string, params: Record<string, string | number>): string {
    const url = new URL(`${this.baseUrl}${endpoint}`);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    return url.toString();
  }
}

export const apiClient = new PolymarketAPIClient();
