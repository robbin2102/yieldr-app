export declare let isRunning: boolean;
/**
 * Main hourly cycle:
 * Phase 1 — CoinGlass aggregate (5 calls, ~10s)
 * Phase 2 — TAAPI indicators for all coins (~9 min)
 * Phase 3 — CoinGlass per-coin for top 20 (~7 min)
 * Phase 4 — Build and upsert snapshots (reads OHLCV from ohlcv_15m collection)
 */
export declare function runHourlyCycle(): Promise<void>;
/** Start all cron jobs */
export declare function startCronJobs(): void;
