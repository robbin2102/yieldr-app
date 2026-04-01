import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { TraderLoader } from './traderLoader';
import { ICopyTrader } from '../db/models/CopyTrader';
import { CopyTrade } from '../db/models/CopyTrade';

interface ActivityResponse {
  timestamp: number;
  type: 'TRADE' | 'SPLIT' | 'MERGE' | 'REDEEM' | 'REWARD' | 'CONVERSION';
  side?: 'BUY' | 'SELL';
  size: number;
  price: number;
  usdcSize: number;
  asset: string;
  conditionId: string;
  title: string;
  outcome: string;
  transactionHash: string;
}

/**
 * MultiDetector — polls all active traders from ahf-copyTraders.
 *
 * Architecture:
 *   - Each trader runs its own async polling chain (setTimeout, not setInterval)
 *     → prevents overlapping polls for the same wallet
 *     → supports per-trader detectorIntervalMs override
 *
 *   - A watchdog timer checks every 60s for newly activated traders
 *     → add a trader to DB and it starts being copied within 60s, no restart
 *
 *   - Only TRADE(BUY) and TRADE(SELL) are forwarded to executor
 *     → REDEEM/MERGE/SPLIT are logged as NON_TRADE skips for visibility
 *
 * Per-trade event payload (DetectedTradeEvent):
 *   traderConfig      — full trader config (avgBet, allocation, etc.)
 *   detectedAt        — Date.now() when we saw this activity
 *   discoveryLatencyMs— detectedAt - activity.timestamp*1000
 *   ...activity fields
 */

export interface DetectedTradeEvent {
  // Trader context
  traderConfig: ICopyTrader;

  // Timing
  detectedAt: number;          // unix ms — when our detector saw it
  discoveryLatencyMs: number;  // detectedAt - traderTs

  // Activity fields
  txHash: string;
  conditionId: string;
  tokenId: string;
  title: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  traderBetUsdc: number;
  traderPrice: number;
  traderSize: number;
  traderTs: number;            // unix ms — trader's tx timestamp
}

export class MultiDetector {
  private activeWallets: Set<string> = new Set();
  private watchdogTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  async start(): Promise<void> {
    console.log('[MultiDetector] Starting...');

    const traders = await TraderLoader.getActive();
    console.log(`[MultiDetector] Found ${traders.length} active traders`);

    for (const trader of traders) {
      this.startPollingChain(trader);
    }

    // Watchdog: pick up newly activated traders without restart
    this.watchdogTimer = setInterval(() => this.watchdog(), 60_000);
    console.log('[MultiDetector] Watchdog started (60s interval for new traders)');
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    console.log('[MultiDetector] Stopped');
  }

  private startPollingChain(trader: ICopyTrader): void {
    if (this.activeWallets.has(trader.wallet)) return; // already running
    this.activeWallets.add(trader.wallet);

    const interval = trader.detectorIntervalMs ?? config.detectorIntervalMs;
    console.log(`[MultiDetector] Polling ${trader.label} (${trader.wallet.slice(0, 10)}...) every ${interval / 1000}s`);

    const tick = async () => {
      if (this.stopped) return;
      await this.pollTrader(trader.wallet);

      // Re-read config each cycle — picks up detectorIntervalMs changes
      const fresh = await TraderLoader.get(trader.wallet);
      if (!fresh || !fresh.active) {
        this.activeWallets.delete(trader.wallet);
        console.log(`[MultiDetector] Stopped polling ${trader.wallet.slice(0, 10)}... (inactive)`);
        return;
      }

      const nextInterval = fresh.detectorIntervalMs ?? config.detectorIntervalMs;
      setTimeout(tick, nextInterval);
    };

    // Stagger start by random 0-2s to avoid thundering herd on startup
    const stagger = Math.floor(Math.random() * 2000);
    setTimeout(tick, stagger);
  }

  private async pollTrader(wallet: string): Promise<void> {
    const trader = await TraderLoader.get(wallet);
    if (!trader) return;

    await TraderLoader.updateLastPolled(wallet);

    let activities: ActivityResponse[] = [];
    try {
      const url = `${config.dataApiBase}/activity?user=${wallet}&limit=50&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[MultiDetector] ${trader.label}: API ${res.status}`);
        return;
      }
      const data = await res.json() as any;
      activities = (Array.isArray(data) ? data : data.data ?? []) as ActivityResponse[];
    } catch (err: any) {
      console.warn(`[MultiDetector] ${trader.label}: fetch error — ${err.message}`);
      return;
    }

    // Filter to only new activities (after lastSeenTs)
    const newActivities = activities.filter(a => a.timestamp > trader.lastSeenTs);

    const ts = new Date().toISOString().slice(11, 19);  // HH:MM:SS
    if (newActivities.length === 0) {
      // Heartbeat — proves polling is alive even when quiet
      console.log(`[${ts}] 👁  ${trader.label.padEnd(20)} — no new activity (lastSeen: ${new Date(trader.lastSeenTs * 1000).toISOString().slice(0, 16)})`);
      return;
    }

    console.log(`[${ts}] 🔔 ${trader.label}: ${newActivities.length} new activit${newActivities.length === 1 ? 'y' : 'ies'} detected`);

    // Advance cursor to the most recent timestamp
    const maxTs = Math.max(...newActivities.map(a => a.timestamp));
    await TraderLoader.updateLastSeen(wallet, maxTs);

    const now = Date.now();

    for (const act of newActivities) {
      const traderTs = act.timestamp * 1000;
      const discoveryLatencyMs = now - traderTs;

      // Skip non-TRADE activities — log them for visibility
      if (act.type !== 'TRADE' || !act.side) {
        await this.logNonTrade(trader, act, traderTs, discoveryLatencyMs);
        continue;
      }

      const event: DetectedTradeEvent = {
        traderConfig: trader,
        detectedAt: now,
        discoveryLatencyMs,
        txHash: act.transactionHash,
        conditionId: act.conditionId,
        tokenId: act.asset,
        title: act.title,
        outcome: act.outcome,
        side: act.side,
        traderBetUsdc: act.usdcSize,
        traderPrice: act.price,
        traderSize: act.size,
        traderTs,
      };

      eventBus.emit('trade:detected', event);
    }
  }

  /** Log REDEEM/MERGE/SPLIT as NON_TRADE skips for analysis */
  private async logNonTrade(
    trader: ICopyTrader,
    act: ActivityResponse,
    traderTs: number,
    discoveryLatencyMs: number
  ): Promise<void> {
    try {
      await CopyTrade.create({
        sourceWallet: trader.wallet,
        traderLabel: trader.label,
        txHash: act.transactionHash,
        conditionId: act.conditionId,
        tokenId: act.asset,
        title: act.title,
        outcome: act.outcome,
        side: act.side ?? 'BUY',
        traderBetUsdc: act.usdcSize,
        traderPrice: act.price,
        traderSize: act.size,
        copyBetUsdc: 0,
        skipReason: 'NON_TRADE',
        skipDetail: `type=${act.type}`,
        traderTs,
        detectedAt: Date.now(),
        discoveryLatencyMs,
        status: 'SKIPPED',
      });
    } catch (err: any) {
      if (err.code !== 11000) console.warn(`[MultiDetector] NON_TRADE log error: ${err.message}`);
    }
  }

  /** Check for newly activated traders and start their polling chains */
  private async watchdog(): Promise<void> {
    if (this.stopped) return;
    const traders = await TraderLoader.getActive();
    for (const t of traders) {
      if (!this.activeWallets.has(t.wallet)) {
        console.log(`[MultiDetector] Watchdog: new trader found — ${t.label}`);
        this.startPollingChain(t);
      }
    }
  }
}
