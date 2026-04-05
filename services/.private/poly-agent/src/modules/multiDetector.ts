import { config } from '../config';
import { eventBus } from '../state/eventBus';
import { waitForConnection } from '../db/connection';
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
  private statusTimer:   NodeJS.Timeout | null = null;
  private stopped = false;

  // In-memory cycle counters — reset each hour
  private cycleHour    = '';
  private cycleStart   = Date.now();
  private cycleTotal   = 0;       // total activities detected this hour
  private cycleTrades  = 0;       // TRADE activities forwarded to executor
  private cycleByLabel = new Map<string, number>(); // label → trade count

  /**
   * Fetch with timeout + one retry on 408/5xx.
   * Logs full response body + key headers on any non-ok status for diagnosis.
   */
  private async fetchActivity(url: string, label: string): Promise<Response> {
    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'poly-agent/3 (+https://polymarket.com)' },
        });
        return res;
      } finally {
        clearTimeout(timer);
      }
    };

    const diagnose = async (res: Response, attemptNum: number): Promise<void> => {
      const ts = new Date().toISOString().slice(11, 19);
      let body = '';
      try { body = (await res.clone().text()).slice(0, 300); } catch {}
      const cfRay   = res.headers.get('cf-ray') ?? '—';
      const rateRem = res.headers.get('x-ratelimit-remaining') ?? '—';
      const retryAft = res.headers.get('retry-after') ?? '—';
      console.warn(
        `[${ts}] [MultiDetector] ${label}: HTTP ${res.status} (attempt ${attemptNum})\n` +
        `  URL:           ${url.replace(/(user=0x[a-f0-9]{8})[a-f0-9]+/, '$1...')}\n` +
        `  CF-Ray:        ${cfRay}\n` +
        `  RateLimit-Rem: ${rateRem}  Retry-After: ${retryAft}\n` +
        `  Body:          ${body || '(empty)'}`
      );
    };

    let res = await attempt();

    if (!res.ok) {
      await diagnose(res, 1);
      if (res.status === 408 || res.status >= 500) {
        console.warn(`[MultiDetector] ${label}: retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3_000));
        res = await attempt();
        if (!res.ok) await diagnose(res, 2);
      }
    }

    return res;
  }

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

    // Status line every 10 minutes — shows cycle activity count without flooding
    this.statusTimer = setInterval(() => this.printCycleStatus(), 10 * 60_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
    if (this.statusTimer)   { clearInterval(this.statusTimer);   this.statusTimer   = null; }
    console.log('[MultiDetector] Stopped');
  }

  private printCycleStatus(): void {
    const elapsedMin = Math.round((Date.now() - this.cycleStart) / 60_000);
    const breakdown  = [...this.cycleByLabel.entries()]
      .filter(([, n]) => n > 0)
      .map(([l, n]) => `${l.split('-')[0]}:${n}`)
      .join(' ');
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] 📊 Cycle ${elapsedMin}m | activities:${this.cycleTotal} trades:${this.cycleTrades}${breakdown ? ` (${breakdown})` : ''}`);
  }

  /** Reset cycle counters on the hour boundary */
  private checkHourReset(): void {
    const hour = new Date().toISOString().slice(0, 13); // "2026-04-04T11"
    if (hour !== this.cycleHour) {
      this.cycleHour    = hour;
      this.cycleStart   = Date.now();
      this.cycleTotal   = 0;
      this.cycleTrades  = 0;
      this.cycleByLabel.clear();
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`\n[${ts}] ⏰ Hour cycle reset — monitoring ${this.activeWallets.size} traders`);
    }
  }

  private startPollingChain(trader: ICopyTrader): void {
    if (this.activeWallets.has(trader.wallet)) return; // already running
    this.activeWallets.add(trader.wallet);

    const interval = trader.detectorIntervalMs ?? config.detectorIntervalMs;
    console.log(`[MultiDetector] Polling ${trader.label} (${trader.wallet.slice(0, 10)}...) every ${interval / 1000}s`);

    const tick = async () => {
      if (this.stopped) return;
      const tickStart = Date.now();
      await this.pollTrader(trader.wallet);

      // Re-read config each cycle — picks up detectorIntervalMs changes
      const fresh = await TraderLoader.get(trader.wallet);
      if (!fresh || !fresh.active) {
        this.activeWallets.delete(trader.wallet);
        console.log(`[MultiDetector] Stopped polling ${trader.wallet.slice(0, 10)}... (inactive)`);
        return;
      }

      // Subtract elapsed time so each trader holds a steady cadence regardless
      // of API response time. Without this, slow polls accumulate into the next
      // timer and traders gradually drift out of their intended interval.
      const nextInterval = fresh.detectorIntervalMs ?? config.detectorIntervalMs;
      const elapsed = Date.now() - tickStart;
      const nextDelay = Math.max(0, nextInterval - elapsed);
      setTimeout(tick, nextDelay);
    };

    // Small random stagger (0–1s) to avoid all traders firing at identical ms on startup.
    // Rate limits are not a concern (Data API: 1,000 req/10s; we do ~7 req/min).
    const stagger = Math.floor(Math.random() * 1000);
    setTimeout(tick, stagger);
  }

  private async pollTrader(wallet: string): Promise<void> {
    // Wait for DB to be available before any Mongoose calls.
    // On transient disconnect this pauses the poll cycle rather than throwing.
    try {
      await waitForConnection(30_000);
    } catch {
      console.warn(`[MultiDetector] DB not ready — skipping poll for ${wallet.slice(0, 10)}...`);
      return;
    }

    const trader = await TraderLoader.get(wallet);
    if (!trader) return;

    await TraderLoader.updateLastPolled(wallet);

    let activities: ActivityResponse[] = [];
    try {
      const url = `${config.dataApiBase}/activity?user=${wallet}&limit=50&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`;
      const res = await this.fetchActivity(url, trader.label);
      if (!res.ok) {
        const ts = new Date().toISOString().slice(11, 19);
        console.warn(`[${ts}] [MultiDetector] ${trader.label}: API ${res.status} — skipping poll`);
        return;
      }
      const data = await res.json() as any;
      activities = (Array.isArray(data) ? data : data.data ?? []) as ActivityResponse[];
    } catch (err: any) {
      const ts = new Date().toISOString().slice(11, 19);
      const reason = (err as any)?.name === 'AbortError' ? 'request timed out (8s)' : err.message;
      console.warn(`[${ts}] [MultiDetector] ${trader.label}: fetch error — ${reason}`);
      return;
    }

    // Filter to only new activities (after lastSeenTs)
    const newActivities = activities.filter(a => a.timestamp > trader.lastSeenTs);

    this.checkHourReset();
    const ts = new Date().toISOString().slice(11, 19);

    if (newActivities.length === 0) return; // silent — cycle summary shown every 10m

    this.cycleTotal += newActivities.length;
    console.log(`[${ts}] 🔔 ${trader.label}: ${newActivities.length} new activit${newActivities.length === 1 ? 'y' : 'ies'} detected`);

    // Advance cursor to the most recent timestamp
    const maxTs = Math.max(...newActivities.map(a => a.timestamp));
    await TraderLoader.updateLastSeen(wallet, maxTs);

    const now = Date.now();

    for (const act of newActivities) {
      const traderTs = act.timestamp * 1000;
      const discoveryLatencyMs = now - traderTs;

      // Skip stale activities — backlog replay guard.
      // If the activity is older than maxLagMs it was missed during downtime;
      // executing it now would be trading on stale signal.
      if (discoveryLatencyMs > config.maxLagMs) {
        const lagSec = (discoveryLatencyMs / 1000).toFixed(0);
        console.log(`[${ts}]     ⏩ STALE ${act.transactionHash.slice(0, 12)}... lag ${lagSec}s > ${config.maxLagMs / 1000}s limit — skipped`);
        continue;
      }

      // Skip non-TRADE activities — log them for visibility
      if (act.type !== 'TRADE' || !act.side) {
        await this.logNonTrade(trader, act, traderTs, discoveryLatencyMs);
        continue;
      }

      this.cycleTrades++;
      this.cycleByLabel.set(trader.label, (this.cycleByLabel.get(trader.label) ?? 0) + 1);

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
        side: (act.side || 'BUY') as 'BUY' | 'SELL',
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
