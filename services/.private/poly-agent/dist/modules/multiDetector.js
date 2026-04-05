"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiDetector = void 0;
const config_1 = require("../config");
const eventBus_1 = require("../state/eventBus");
const connection_1 = require("../db/connection");
const traderLoader_1 = require("./traderLoader");
const CopyTrade_1 = require("../db/models/CopyTrade");
class MultiDetector {
    constructor() {
        this.activeWallets = new Set();
        this.watchdogTimer = null;
        this.statusTimer = null;
        this.stopped = false;
        // In-memory cycle counters — reset each hour
        this.cycleHour = '';
        this.cycleStart = Date.now();
        this.cycleTotal = 0; // total activities detected this hour
        this.cycleTrades = 0; // TRADE activities forwarded to executor
        this.cycleByLabel = new Map(); // label → trade count
    }
    /**
     * Fetch with timeout + one retry on 408/5xx.
     * Logs full response body + key headers on any non-ok status for diagnosis.
     */
    async fetchActivity(url, label) {
        const attempt = async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const res = await fetch(url, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'poly-agent/3 (+https://polymarket.com)' },
                });
                return res;
            }
            finally {
                clearTimeout(timer);
            }
        };
        const diagnose = async (res, attemptNum) => {
            const ts = new Date().toISOString().slice(11, 19);
            let body = '';
            try {
                body = (await res.clone().text()).slice(0, 300);
            }
            catch { }
            const cfRay = res.headers.get('cf-ray') ?? '—';
            const rateRem = res.headers.get('x-ratelimit-remaining') ?? '—';
            const retryAft = res.headers.get('retry-after') ?? '—';
            console.warn(`[${ts}] [MultiDetector] ${label}: HTTP ${res.status} (attempt ${attemptNum})\n` +
                `  URL:           ${url.replace(/(user=0x[a-f0-9]{8})[a-f0-9]+/, '$1...')}\n` +
                `  CF-Ray:        ${cfRay}\n` +
                `  RateLimit-Rem: ${rateRem}  Retry-After: ${retryAft}\n` +
                `  Body:          ${body || '(empty)'}`);
        };
        let res = await attempt();
        if (!res.ok) {
            await diagnose(res, 1);
            if (res.status === 408 || res.status >= 500) {
                console.warn(`[MultiDetector] ${label}: retrying in 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                res = await attempt();
                if (!res.ok)
                    await diagnose(res, 2);
            }
        }
        return res;
    }
    async start() {
        console.log('[MultiDetector] Starting...');
        const traders = await traderLoader_1.TraderLoader.getActive();
        console.log(`[MultiDetector] Found ${traders.length} active traders`);
        for (const trader of traders) {
            this.startPollingChain(trader);
        }
        // Watchdog: pick up newly activated traders without restart
        this.watchdogTimer = setInterval(() => this.watchdog(), 60000);
        console.log('[MultiDetector] Watchdog started (60s interval for new traders)');
        // Status line every 10 minutes — shows cycle activity count without flooding
        this.statusTimer = setInterval(() => this.printCycleStatus(), 10 * 60000);
    }
    stop() {
        this.stopped = true;
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        console.log('[MultiDetector] Stopped');
    }
    printCycleStatus() {
        const elapsedMin = Math.round((Date.now() - this.cycleStart) / 60000);
        const breakdown = [...this.cycleByLabel.entries()]
            .filter(([, n]) => n > 0)
            .map(([l, n]) => `${l.split('-')[0]}:${n}`)
            .join(' ');
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] 📊 Cycle ${elapsedMin}m | activities:${this.cycleTotal} trades:${this.cycleTrades}${breakdown ? ` (${breakdown})` : ''}`);
    }
    /** Reset cycle counters on the hour boundary */
    checkHourReset() {
        const hour = new Date().toISOString().slice(0, 13); // "2026-04-04T11"
        if (hour !== this.cycleHour) {
            this.cycleHour = hour;
            this.cycleStart = Date.now();
            this.cycleTotal = 0;
            this.cycleTrades = 0;
            this.cycleByLabel.clear();
            const ts = new Date().toISOString().slice(11, 19);
            console.log(`\n[${ts}] ⏰ Hour cycle reset — monitoring ${this.activeWallets.size} traders`);
        }
    }
    startPollingChain(trader) {
        if (this.activeWallets.has(trader.wallet))
            return; // already running
        this.activeWallets.add(trader.wallet);
        const interval = trader.detectorIntervalMs ?? config_1.config.detectorIntervalMs;
        console.log(`[MultiDetector] Polling ${trader.label} (${trader.wallet.slice(0, 10)}...) every ${interval / 1000}s`);
        const tick = async () => {
            if (this.stopped)
                return;
            const tickStart = Date.now();
            await this.pollTrader(trader.wallet);
            // Re-read config each cycle — picks up detectorIntervalMs changes
            const fresh = await traderLoader_1.TraderLoader.get(trader.wallet);
            if (!fresh || !fresh.active) {
                this.activeWallets.delete(trader.wallet);
                console.log(`[MultiDetector] Stopped polling ${trader.wallet.slice(0, 10)}... (inactive)`);
                return;
            }
            // Subtract elapsed time so each trader holds a steady cadence regardless
            // of API response time. Without this, slow polls accumulate into the next
            // timer and traders gradually drift out of their intended interval.
            const nextInterval = fresh.detectorIntervalMs ?? config_1.config.detectorIntervalMs;
            const elapsed = Date.now() - tickStart;
            const nextDelay = Math.max(0, nextInterval - elapsed);
            setTimeout(tick, nextDelay);
        };
        // Small random stagger (0–1s) to avoid all traders firing at identical ms on startup.
        // Rate limits are not a concern (Data API: 1,000 req/10s; we do ~7 req/min).
        const stagger = Math.floor(Math.random() * 1000);
        setTimeout(tick, stagger);
    }
    async pollTrader(wallet) {
        // Wait for DB to be available before any Mongoose calls.
        // On transient disconnect this pauses the poll cycle rather than throwing.
        try {
            await (0, connection_1.waitForConnection)(30000);
        }
        catch {
            console.warn(`[MultiDetector] DB not ready — skipping poll for ${wallet.slice(0, 10)}...`);
            return;
        }
        const trader = await traderLoader_1.TraderLoader.get(wallet);
        if (!trader)
            return;
        await traderLoader_1.TraderLoader.updateLastPolled(wallet);
        let activities = [];
        try {
            const url = `${config_1.config.dataApiBase}/activity?user=${wallet}&limit=50&offset=0&sortBy=TIMESTAMP&sortDirection=DESC`;
            const res = await this.fetchActivity(url, trader.label);
            if (!res.ok) {
                const ts = new Date().toISOString().slice(11, 19);
                console.warn(`[${ts}] [MultiDetector] ${trader.label}: API ${res.status} — skipping poll`);
                return;
            }
            const data = await res.json();
            activities = (Array.isArray(data) ? data : data.data ?? []);
        }
        catch (err) {
            const ts = new Date().toISOString().slice(11, 19);
            const reason = err?.name === 'AbortError' ? 'request timed out (8s)' : err.message;
            console.warn(`[${ts}] [MultiDetector] ${trader.label}: fetch error — ${reason}`);
            return;
        }
        // Filter to only new activities (after lastSeenTs)
        const newActivities = activities.filter(a => a.timestamp > trader.lastSeenTs);
        this.checkHourReset();
        const ts = new Date().toISOString().slice(11, 19);
        if (newActivities.length === 0)
            return; // silent — cycle summary shown every 10m
        this.cycleTotal += newActivities.length;
        console.log(`[${ts}] 🔔 ${trader.label}: ${newActivities.length} new activit${newActivities.length === 1 ? 'y' : 'ies'} detected`);
        // Advance cursor to the most recent timestamp
        const maxTs = Math.max(...newActivities.map(a => a.timestamp));
        await traderLoader_1.TraderLoader.updateLastSeen(wallet, maxTs);
        const now = Date.now();
        for (const act of newActivities) {
            const traderTs = act.timestamp * 1000;
            const discoveryLatencyMs = now - traderTs;
            const shortTitle = (act.title ?? act.conditionId?.slice(0, 30) ?? act.asset?.slice(0, 12) ?? '?').slice(0, 45);
            const lagSec = (discoveryLatencyMs / 1000).toFixed(0);
            // Skip stale activities — backlog replay guard.
            if (discoveryLatencyMs > config_1.config.maxLagMs) {
                console.log(`[${ts}]     ⏩ STALE  [${act.side ?? act.type}] "${shortTitle}" — lag ${lagSec}s > ${config_1.config.maxLagMs / 1000}s limit`);
                continue;
            }
            // Skip non-TRADE activities — log inline and record to DB
            if (act.type !== 'TRADE' || !act.side) {
                console.log(`[${ts}]     ↷ NON_TRADE [${act.type}] "${shortTitle}" — skipped`);
                await this.logNonTrade(trader, act, traderTs, discoveryLatencyMs);
                continue;
            }
            console.log(`[${ts}]     → [${act.side}] $${act.usdcSize.toFixed(2)} "${shortTitle}" lag ${lagSec}s — queuing`);
            this.cycleTrades++;
            this.cycleByLabel.set(trader.label, (this.cycleByLabel.get(trader.label) ?? 0) + 1);
            const event = {
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
            eventBus_1.eventBus.emit('trade:detected', event);
        }
    }
    /** Log REDEEM/MERGE/SPLIT as NON_TRADE skips for analysis */
    async logNonTrade(trader, act, traderTs, discoveryLatencyMs) {
        try {
            await CopyTrade_1.CopyTrade.create({
                sourceWallet: trader.wallet,
                traderLabel: trader.label,
                txHash: act.transactionHash,
                conditionId: act.conditionId,
                tokenId: act.asset,
                title: act.title,
                outcome: act.outcome,
                side: (act.side || 'BUY'),
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
        }
        catch (err) {
            if (err.code !== 11000)
                console.warn(`[MultiDetector] NON_TRADE log error: ${err.message}`);
        }
    }
    /** Check for newly activated traders and start their polling chains */
    async watchdog() {
        if (this.stopped)
            return;
        const traders = await traderLoader_1.TraderLoader.getActive();
        for (const t of traders) {
            if (!this.activeWallets.has(t.wallet)) {
                console.log(`[MultiDetector] Watchdog: new trader found — ${t.label}`);
                this.startPollingChain(t);
            }
        }
    }
}
exports.MultiDetector = MultiDetector;
//# sourceMappingURL=multiDetector.js.map