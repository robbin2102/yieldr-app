/**
 * Binance public REST API utilities.
 *
 * NOTE: fetchBinanceCandle (/api/v3/klines) was removed — all price/OHLCV data is
 * now sourced from TAAPI via ohlcv.ts → ohlcv_15m MongoDB collection.
 * binanceGet is kept available for any future use of other Binance public endpoints.
 */
import { config } from '../config';
import { logger } from '../utils/logger';

// All Binance spot hostnames in priority order. Configured primary is tried first,
// then fallbacks in sequence. Once a working host is found it's reused for the session.
const ALL_SPOT_BASES = [
  config.binance.spotBaseUrl,
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

let baseIndex = 0;
let geo451Logged = false;

export async function binanceGet(path: string): Promise<any> {
  for (let attempt = 0; attempt < ALL_SPOT_BASES.length; attempt++) {
    const idx  = (baseIndex + attempt) % ALL_SPOT_BASES.length;
    const base = ALL_SPOT_BASES[idx];
    const res  = await fetch(`${base}${path}`);

    if (res.status === 400) throw new Error(`Binance 400: ${path}`);

    if (res.status === 451) {
      if (!geo451Logged) {
        geo451Logged = true;
        logger.warn('Binance', `451 geo-restriction on ${base} — rotating endpoints. Set BINANCE_SPOT_BASE_URL to override.`);
      }
      continue;
    }

    if (!res.ok) throw new Error(`Binance ${res.status}: ${path}`);

    if (attempt > 0) {
      baseIndex = idx;
      logger.info('Binance', `Using ${base} after 451 on primary (index locked to ${idx})`);
    }
    return res.json();
  }

  throw new Error(`Binance 451: ${path} — all endpoints geo-restricted`);
}
