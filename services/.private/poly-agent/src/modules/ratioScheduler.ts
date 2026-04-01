import { config } from '../config';
import { CopyTrader } from '../db/models/CopyTrader';
import { TraderLoader } from './traderLoader';

/**
 * RatioScheduler — computes and stores a fixed copy_ratio for each active trader.
 *
 * copy_ratio = trader.allocationUsdc / trader.openPositionsUsdc_at_snapshot
 *
 * This ratio is fixed for the day and used by betSizer for all trades.
 * Stable ratio → consistent portfolio mirroring (every position at the same %).
 *
 * Triggers:
 *   1. Session start — computes for all active traders before detector begins
 *   2. Daily at midnight — refreshes ratios so next day reflects current book sizes
 *   3. On-demand via recompute(wallet) — when NO_RATIO is hit mid-session
 *
 * Fallback when openPositionsUsdc = 0 (genuine fresh re-entry or API returned nothing):
 *   ratio = baseBetUsdc / avgBet  → one avg-sized trader bet = one min-bet copy from us
 *   Guard: if avgBet = 0          → ratio = allocationUsdc / 1000  (0.1% absolute floor)
 *   This means a fresh re-entering trader is still copied conservatively rather than skipped.
 *   Midnight recompute will replace the fallback with a real portfolio ratio once positions exist.
 */
export class RatioScheduler {
  private midnightTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /**
   * Compute ratios for all active traders, then schedule daily midnight refresh.
   * Called once at session start before the detector begins.
   */
  async start(): Promise<void> {
    console.log('[RatioScheduler] Computing copy ratios for all active traders...');
    await this.computeAll();
    this.scheduleMidnightRefresh();
    console.log('[RatioScheduler] Daily midnight refresh scheduled.');
  }

  stop(): void {
    this.stopped = true;
    if (this.midnightTimer) {
      clearTimeout(this.midnightTimer);
      this.midnightTimer = null;
    }
  }

  /** Compute and store ratio for every active trader */
  async computeAll(): Promise<void> {
    const traders = await TraderLoader.getActive();
    for (const trader of traders) {
      await this.recompute(trader.wallet);
    }
  }

  /**
   * Fetch open positions for one trader, compute ratio, persist to DB.
   * Called at startup, midnight, and when a new trader is activated.
   */
  async recompute(wallet: string): Promise<void> {
    const trader = await TraderLoader.get(wallet);
    if (!trader) return;

    const openUsdc = await this.fetchOpenPositionsUsdc(wallet);
    const now = new Date();

    if (openUsdc <= 0) {
      // No open positions — use fallback ratio so fresh re-entries are still copied.
      // fallback = baseBetUsdc / avgBet: one avg-sized bet → one min-bet copy.
      const fallbackRatio = trader.avgBet > 0
        ? trader.baseBetUsdc / trader.avgBet
        : trader.allocationUsdc / 1000;  // 0.1% absolute floor if avgBet missing

      await CopyTrader.updateOne(
        { wallet: wallet.toLowerCase() },
        { $set: { openPositionsUsdc: 0, copyRatio: fallbackRatio, copyRatioComputedAt: now } }
      );
      console.log(
        `[RatioScheduler] ${trader.label.padEnd(24)} — no open positions, ` +
        `fallback ratio=${(fallbackRatio * 100).toFixed(2)}% ` +
        `(baseBet $${trader.baseBetUsdc} / avgBet $${trader.avgBet || '?'})`
      );
      return;
    }

    const copyRatio = trader.allocationUsdc / openUsdc;

    await CopyTrader.updateOne(
      { wallet: wallet.toLowerCase() },
      { $set: { openPositionsUsdc: openUsdc, copyRatio, copyRatioComputedAt: now } }
    );

    console.log(
      `[RatioScheduler] ${trader.label.padEnd(24)} ` +
      `open=$${openUsdc.toFixed(0)}  alloc=$${trader.allocationUsdc}  ` +
      `ratio=${(copyRatio * 100).toFixed(2)}%  ` +
      `(every $100 trader bet → $${(100 * copyRatio).toFixed(2)} copy)`
    );
  }

  /**
   * Schedule a refresh at the next midnight (local time).
   * Uses recursive setTimeout rather than setInterval to always land at midnight.
   */
  private scheduleMidnightRefresh(): void {
    const msUntilMidnight = this.msUntilNextMidnight();
    console.log(`[RatioScheduler] Next ratio refresh in ${(msUntilMidnight / 3600000).toFixed(1)}h (midnight)`);

    this.midnightTimer = setTimeout(async () => {
      if (this.stopped) return;
      console.log('\n[RatioScheduler] 🌙 Midnight — refreshing copy ratios...');
      await this.computeAll();
      // Schedule next midnight
      this.scheduleMidnightRefresh();
    }, msUntilMidnight);
  }

  private msUntilNextMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);  // next midnight
    return midnight.getTime() - now.getTime();
  }

  /**
   * Fetch total open position value in USDC for a trader wallet.
   * Positions API: size × current price (or avg cost if available).
   */
  private async fetchOpenPositionsUsdc(wallet: string): Promise<number> {
    try {
      const url = `${config.dataApiBase}/positions?user=${wallet}&sizeThreshold=0.01&limit=500`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[RatioScheduler] ${wallet.slice(0, 10)}...: API ${res.status}`);
        return 0;
      }

      const raw = await res.json() as any;
      const items: any[] = Array.isArray(raw) ? raw : (raw.data ?? []);

      let total = 0;
      for (const item of items) {
        const size = parseFloat(item.size ?? item.sharesOwned ?? '0');
        if (size < 0.01) continue;
        // Prefer avgPrice (cost basis), fallback to currentPrice
        const price = parseFloat(item.avgPrice ?? item.averagePrice ?? '0') ||
          parseFloat(item.currentPrice ?? item.price ?? '0.5');
        total += size * price;
      }
      return total;

    } catch (err: any) {
      console.warn(`[RatioScheduler] ${wallet.slice(0, 10)}...: fetch error — ${err.message}`);
      return 0;
    }
  }
}

export const ratioScheduler = new RatioScheduler();
