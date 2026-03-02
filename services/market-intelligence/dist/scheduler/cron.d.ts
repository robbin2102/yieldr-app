export declare let isRunning: boolean;
/**
 * Main hourly cycle:
 * Phase 1 — CoinGlass aggregate (5 calls, ~10s)
 * Phase 2 — TAAPI indicators for all 100 coins (~3 min)
 * Phase 3 — CoinGlass per-coin for top 20 (~7 min)
 * Phase 4 — Build and upsert snapshots (includes Binance OHLCV per coin)
 */
export declare function runHourlyCycle(): Promise<void>;
/** Start all cron jobs */
export declare function startCronJobs(): void;
