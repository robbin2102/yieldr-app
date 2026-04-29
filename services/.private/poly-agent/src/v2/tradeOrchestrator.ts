/**
 * TradeOrchestrator — v2 main pipeline.
 *
 * Wires OnChainDetector → dedup → meta resolution → bet sizing → safety
 * → ExecutionRouter → MarketOrderExecutor | GTDExecutorV2 → TradeRecorder.
 *
 * Instantiate once and call start(). Everything runs event-driven from
 * the OnChainDetector WS connection.
 *
 * Concurrent trade handling:
 *   - Per-position BUY cap: in-memory reservation map (positionReserved)
 *   - Per-token SELL guard: in-memory set (sellInProgress)
 *   - Both are synchronous checks before the first await — no race condition
 *
 * Strategy switching (no restart required):
 *   orchestrator.router.setGlobalStrategy('market')
 *   orchestrator.router.setStrategy(tokenId, 'gtd')
 *   orchestrator.router.setExchangeStrategy('CTF', 'market')
 */

import { OnChainDetector, DetectedTrade } from '../modules/onChainDetector';
import { ClobV2Client }        from './clob/clobV2Client';
import { OrderbookCacheV2 }    from './state/orderbookCache';
import { SafetyGuard }         from './state/safetyGuard';
import { MarketMetaResolver }  from './state/marketMetaResolver';
import { FillTrackerV2 }       from './state/fillTrackerV2';
import { MarketOrderExecutor } from './execution/marketOrderExecutor';
import { GTDExecutorV2 }       from './execution/gtdExecutorV2';
import { ExecutionRouter }     from './execution/executionRouter';
import { TradeRecorder }       from './db/tradeRecorder';
import { TraderLoader }        from '../modules/traderLoader';
import { calcCopyBet }         from '../modules/betSizer';
import { positionFetcher }     from '../modules/positionFetcher';
import { CopyTrade }           from '../db/models/CopyTrade';
import { RoutedTrade, ExecutionStrategy } from './types';

// ── Config ────────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  // Detection
  polygonWsUrl:  string;
  polygonHttpUrl: string;
  mongoUri:      string;
  dbName:        string;

  // Execution
  clobHost:      string;
  privateKey:    string;
  apiKey:        string;
  apiSecret:     string;
  passphrase:    string;
  polygonRpc:    string;
  botAddress:    string;

  // Optional exchange filter — if set, only execute on these exchanges (comma-separated).
  // Detection always runs on all exchanges. Example: 'NEG_RISK_V2' to only execute
  // on politics/geopolitical markets while staying in detect-only mode for sports etc.
  execExchanges?: string[];  // e.g. ['NEG_RISK_V2'] or ['CTF_V2','NEG_RISK_V2']

  // WS User Channel
  wssUserUrl:    string;

  // Safety
  maxDriftPct:   number;    // e.g. 0.05 (5%)
  maxSpreadPct:  number;    // e.g. 0.10 (10%)

  // Execution
  maxMarketAttempts: number;  // FAK retries (default 5)
  maxGtdAttempts:    number;  // GTD retries (default 3)
  defaultStrategy:   ExecutionStrategy;
  detectionOnly:     boolean; // log detections but skip all execution (testing mode)

  // Bot-level base bet: if set, minimum copy bet = baseShares × impliedPrice.
  // Overrides per-trader baseBetUsdc floor. Unset = use per-trader baseBetUsdc.
  baseShares?: number;  // e.g. 5
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtLine(
  trade:  import('../modules/onChainDetector').DetectedTrade,
  suffix: string,
  meta?:  { title?: string; outcome?: string } | null,
): string {
  const now     = new Date().toISOString().slice(11, 19);
  const blockTs = new Date(trade.blockTimestampMs).toISOString().slice(11, 19);
  const lagMs   = trade.receivedAtMs - trade.blockTimestampMs;
  const lagStr  = lagMs >= 0 ? `+${lagMs}ms` : `${lagMs}ms`;

  const price    = `@$${trade.impliedPrice.toFixed(3)}`;
  const shares   = `${trade.tokenAmount.toFixed(1)}sh`;
  const outcome  = meta?.outcome ? ` ${meta.outcome}` : '';
  const title    = meta?.title
    ? `"${meta.title.slice(0, 40)}${meta.title.length > 40 ? '…' : ''}"`
    : `"${trade.tokenId.slice(0, 10)}..."`;
  const catchup  = lagMs > 10_000 ? ' [CATCHUP]' : '';

  return `[${now}] ${trade.label} ${trade.side} $${trade.usdcAmount.toFixed(0)} ${price} (${shares}${outcome}) ${title} block=${blockTs} lag=${lagStr}${catchup} | ${suffix}`;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class TradeOrchestrator {
  readonly router: ExecutionRouter;

  private detector:      OnChainDetector;
  private books:         OrderbookCacheV2;
  private fillTracker:   FillTrackerV2;
  private detectionOnly:  boolean;
  private execExchanges?: string[];
  private baseShares?:    number;

  // Concurrent trade guards (synchronous — no await between check and set)
  private positionReserved = new Map<string, number>();  // `wallet:conditionId` → USDC reserved
  private sellInProgress   = new Set<string>();          // tokenId

  private constructor(
    detector:      OnChainDetector,
    books:         OrderbookCacheV2,
    fillTracker:   FillTrackerV2,
    router:        ExecutionRouter,
    detectionOnly: boolean,
    execExchanges?: string[],
    baseShares?:    number,
  ) {
    this.detector      = detector;
    this.books         = books;
    this.fillTracker   = fillTracker;
    this.detectionOnly = detectionOnly;
    this.execExchanges = execExchanges;
    this.baseShares    = baseShares;
    this.router        = router;
  }

  static async create(cfg: OrchestratorConfig): Promise<TradeOrchestrator> {
    // Skip CLOB client entirely in detection-only mode — getOk() can take 2+ min
    // to time out when the API is unreachable, blocking the detector from starting.
    let clob: ClobV2Client | null = null;
    if (!cfg.detectionOnly) {
      clob = await ClobV2Client.create({
        host:       cfg.clobHost,
        privateKey: cfg.privateKey,
        apiKey:     cfg.apiKey,
        apiSecret:  cfg.apiSecret,
        passphrase: cfg.passphrase,
        polygonRpc: cfg.polygonRpc,
      });
    }

    const books      = new OrderbookCacheV2(cfg.clobHost);
    const safety     = new SafetyGuard(cfg.maxDriftPct, cfg.maxSpreadPct);
    const resolver   = new MarketMetaResolver(cfg.clobHost);
    const recorder   = new TradeRecorder();
    const fillTracker = new FillTrackerV2(
      cfg.wssUserUrl, cfg.apiKey, cfg.apiSecret, cfg.passphrase, cfg.botAddress
    );

    const marketExec = new MarketOrderExecutor(clob as ClobV2Client, books, safety, recorder, cfg.maxMarketAttempts);
    const gtdExec    = new GTDExecutorV2(clob as ClobV2Client, books, safety, recorder, fillTracker, cfg.maxGtdAttempts);

    const router = new ExecutionRouter(marketExec, gtdExec, cfg.defaultStrategy);

    const detector = new OnChainDetector({
      wsUrl:    cfg.polygonWsUrl,
      httpUrl:  cfg.polygonHttpUrl,
      mongoUri: cfg.mongoUri,
      dbName:   cfg.dbName,
    });

    const orchestrator = new TradeOrchestrator(detector, books, fillTracker, router, cfg.detectionOnly ?? false, cfg.execExchanges, cfg.baseShares);

    // Wire detector events
    detector.on('trade',       (t) => orchestrator.handleDetected(t, resolver, recorder));
    detector.on('connected',   ()  => console.log('[Orchestrator] Detector connected'));
    detector.on('reconnecting', (e) => console.log(`[Orchestrator] Reconnecting (delay=${e.delayMs}ms)`));
    detector.on('error',       (e) => console.error('[Orchestrator] Detector error:', e.message));

    // FillTrackerV2 connects and tracks GTD orders
    fillTracker.on('order:submitted', (p) => fillTracker.trackOrder(p));

    return orchestrator;
  }

  async start(): Promise<void> {
    if (!this.detectionOnly) this.fillTracker.connect();
    await this.detector.start();
    console.log('[Orchestrator] v2 pipeline started');
  }

  stop(): void {
    this.detector.stop();
    this.fillTracker.stop();
    console.log('[Orchestrator] Stopped');
  }

  // ── Trade pipeline ─────────────────────────────────────────────────────────

  private async handleDetected(
    trade:    DetectedTrade,
    resolver: MarketMetaResolver,
    recorder: TradeRecorder,
  ): Promise<void> {
    // ── 0. Skip stale events (backlog replay on reconnect, older than 5min) ─
    if (trade.isStale) {
      const ageS = Math.round((Date.now() - trade.blockTimestampMs) / 1000);
      console.log(`[Orchestrator] Stale fill skipped: ${trade.label} ${trade.side} $${trade.usdcAmount.toFixed(0)} age=${ageS}s block=${new Date(trade.blockTimestampMs).toISOString().slice(11, 19)}`);
      return;
    }

    // ── 1. Prefetch orderbook in parallel with everything below ───────────
    this.books.prefetch(trade.tokenId);

    // ── 2. Resolve market metadata ────────────────────────────────────────
    const meta = await resolver.resolve(trade.tokenId, trade.exchange === 'NEG_RISK' || trade.exchange === 'NEG_RISK_V2');
    if (!meta) {
      console.warn(`[Orchestrator] Could not resolve market meta for ${trade.tokenId.slice(0, 14)}... — skipping`);
      return;
    }

    // ── 3. Load trader config (fresh — picks up allocation changes) ───────
    const trader = await TraderLoader.get(trade.wallet);
    if (!trader) return;

    // ── 4. Deduplication — MongoDB unique index on txHash ─────────────────
    let tradeDocId: string;
    try {
      tradeDocId = await recorder.createDetected({
        ...trade,
        meta,
        strategy:    'market',  // placeholder — set properly below
        copyBetUsdc: 0,
        label:       trader.label,
      } as RoutedTrade);
    } catch (err: any) {
      if (err.code === 11000) {
        // Duplicate key: another process (e.g. detection-only Fly service) wrote this
        // txHash first. If it's DETECT_ONLY we can re-use the record and execute.
        // Any other status (EXECUTING, FILLED, SKIPPED, FAILED) means it's already handled.
        const existing = await CopyTrade.findOne({ txHash: trade.txHash }, { _id: 1, status: 1 }).lean();
        if (existing?.status === 'DETECT_ONLY') {
          tradeDocId = (existing._id as any).toString();
        } else {
          return;
        }
      } else {
        throw err;
      }
    }

    // ── 5. Resolve execution strategy ─────────────────────────────────────
    const strategy = this.router.resolve(trade.tokenId, trade.exchange);

    // ── 6. SELL path ───────────────────────────────────────────────────────
    if (trade.side === 'SELL') {
      await this.handleSell(trade, meta, trader, strategy, recorder);
      return;
    }

    // ── 7. BUY: bet sizing ────────────────────────────────────────────────
    // Bot-level baseShares overrides per-trader baseBetUsdc: floor = baseShares × impliedPrice.
    const effectiveBaseBet = this.baseShares
      ? this.baseShares * trade.impliedPrice
      : trader.baseBetUsdc;
    const sizing = calcCopyBet(trade.usdcAmount, { ...trader, baseBetUsdc: effectiveBaseBet });
    if (sizing.skip) {
      console.log(fmtLine(trade, `⏭  SKIP → ${sizing.skipReason} ${sizing.skipDetail ?? ''}`, meta));
      await recorder.skip(
        { ...trade, meta, strategy, copyBetUsdc: 0 } as RoutedTrade,
        sizing.skipReason!,
        sizing.skipDetail,
      );
      return;
    }
    await TraderLoader.recordAboveAvg(trade.wallet);

    // ── 8. Per-position cap (synchronous reservation before any await) ─────
    const lockKey       = `${trader.wallet}:${meta.conditionId}`;
    const alreadyReserved = this.positionReserved.get(lockKey) ?? 0;
    this.positionReserved.set(lockKey, alreadyReserved + sizing.betUsdc);

    const dbSpent        = await this.getPositionSpent(trader.wallet, trade.tokenId, meta.conditionId);
    const maxPerPosition = trader.allocationUsdc * 0.20;
    const positionAvail  = maxPerPosition - dbSpent - alreadyReserved;

    if (positionAvail <= 0) {
      const cur = this.positionReserved.get(lockKey) ?? 0;
      const upd = Math.max(0, cur - sizing.betUsdc);
      if (upd === 0) this.positionReserved.delete(lockKey); else this.positionReserved.set(lockKey, upd);
      console.log(fmtLine(trade, `⏭  SKIP → POSITION_CAP_FULL`, meta));
      await recorder.skip({ ...trade, meta, strategy, copyBetUsdc: sizing.betUsdc } as RoutedTrade, 'POSITION_CAP_FULL');
      return;
    }

    const copyBetUsdc = Math.min(sizing.betUsdc, positionAvail);

    const ratio   = (trade.usdcAmount / trader.avgBet).toFixed(1);
    const execTag = this.detectionOnly ? '[DETECT_ONLY]' : `[${strategy.toUpperCase()}]`;
    console.log(fmtLine(trade, `×${ratio} avg → copy $${copyBetUsdc.toFixed(2)} ${execTag}`, meta));

    // ── 9. Route to executor ───────────────────────────────────────────────
    if (this.detectionOnly) {
      // In detection-only mode mark as DETECT_ONLY so it doesn't count against
      // position caps on the next run (EXECUTING records would permanently block sizing).
      await CopyTrade.updateOne({ txHash: trade.txHash }, { $set: { copyBetUsdc, status: 'DETECT_ONLY' } });
      const cur = this.positionReserved.get(lockKey) ?? 0;
      const upd = Math.max(0, cur - sizing.betUsdc);
      if (upd === 0) this.positionReserved.delete(lockKey); else this.positionReserved.set(lockKey, upd);
      return;
    }

    // Exchange filter — skip execution (mark DETECT_ONLY) if trade's exchange not in EXEC_EXCHANGES.
    // Detection always runs on all exchanges regardless of this filter.
    if (this.execExchanges && this.execExchanges.length > 0 && !this.execExchanges.includes(trade.exchange)) {
      console.log(fmtLine(trade, `⏭  DETECT_ONLY → EXEC_FILTER (${trade.exchange})`, meta));
      await CopyTrade.updateOne({ txHash: trade.txHash }, { $set: { copyBetUsdc, status: 'DETECT_ONLY', skipDetail: `exec_filter:${trade.exchange}` } });
      const cur = this.positionReserved.get(lockKey) ?? 0;
      const upd = Math.max(0, cur - sizing.betUsdc);
      if (upd === 0) this.positionReserved.delete(lockKey); else this.positionReserved.set(lockKey, upd);
      return;
    }

    // Release reservation after DB write (reservation was worst-case)
    try {
      await CopyTrade.updateOne({ txHash: trade.txHash }, { $set: { copyBetUsdc, status: 'EXECUTING' } });
    } finally {
      const cur = this.positionReserved.get(lockKey) ?? 0;
      const upd = Math.max(0, cur - sizing.betUsdc);
      if (upd === 0) this.positionReserved.delete(lockKey); else this.positionReserved.set(lockKey, upd);
    }
    const routed: RoutedTrade = {
      txHash:           trade.txHash,
      wallet:           trade.wallet,
      label:            trader.label,
      side:             trade.side,
      usdcAmount:       trade.usdcAmount,
      tokenAmount:      trade.tokenAmount,
      impliedPrice:     trade.impliedPrice,
      tokenId:          trade.tokenId,
      exchange:         trade.exchange,
      blockTimestampMs: trade.blockTimestampMs,
      receivedAtMs:     trade.receivedAtMs,
      lagMs:            trade.lagMs,
      meta,
      strategy,
      copyBetUsdc,
      tradeDocId,
    };

    await this.router.route(routed);
  }

  private async handleSell(
    trade:    DetectedTrade,
    meta:     any,
    trader:   any,
    strategy: 'market' | 'gtd',
    recorder: TradeRecorder,
  ): Promise<void> {
    // Concurrent SELL guard — two SELLs for same token arriving simultaneously
    if (this.sellInProgress.has(trade.tokenId)) {
      await recorder.skip({ ...trade, meta, strategy, copyBetUsdc: 0 } as RoutedTrade, 'SELL_NO_POSITION', 'concurrent SELL in progress');
      return;
    }
    this.sellInProgress.add(trade.tokenId);

    try {
      const ourShares = await positionFetcher.getOurShares(trade.tokenId);
      if (ourShares < 0.01) {
        await recorder.skip({ ...trade, meta, strategy, copyBetUsdc: 0 } as RoutedTrade, 'SELL_NO_POSITION', `have ${ourShares.toFixed(4)} shares`);
        return;
      }

      // Proportional exit: sell same fraction of our position as trader
      const traderTotal = await this.getTraderTotalBoughtShares(trader.wallet, trade.tokenId, meta.conditionId);
      const exitFraction = traderTotal > 0 ? Math.min(trade.tokenAmount / traderTotal, 1.0) : 1.0;
      const exitShares   = Math.min(exitFraction * ourShares, ourShares);

      if (exitShares < 0.01) {
        await recorder.skip({ ...trade, meta, strategy, copyBetUsdc: 0 } as RoutedTrade, 'SELL_NO_POSITION', `exit shares too small (${exitShares.toFixed(4)})`);
        return;
      }

      const ts = new Date().toISOString().slice(11, 19);
      console.log(`\n[${ts}] ${trader.label} SELL: exit ${(exitFraction * 100).toFixed(1)}% → ${exitShares.toFixed(4)} of our ${ourShares.toFixed(4)} shares [${strategy.toUpperCase()}]`);

      const routed: RoutedTrade = {
        txHash:           trade.txHash,
        wallet:           trade.wallet,
        label:            trader.label,
        side:             'SELL',
        usdcAmount:       trade.usdcAmount,
        tokenAmount:      trade.tokenAmount,
        impliedPrice:     trade.impliedPrice,
        tokenId:          trade.tokenId,
        exchange:         trade.exchange,
        blockTimestampMs: trade.blockTimestampMs,
        receivedAtMs:     trade.receivedAtMs,
        lagMs:            trade.lagMs,
        meta,
        strategy,
        copyBetUsdc:  0,    // not used for SELL
        copyShares:   exitShares,
      };

      await CopyTrade.updateOne({ txHash: trade.txHash }, { $set: { status: 'EXECUTING', copyBetUsdc: exitShares } });
      await this.router.route(routed);
    } finally {
      this.sellInProgress.delete(trade.tokenId);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getPositionSpent(wallet: string, tokenId: string, conditionId: string): Promise<number> {
    const filter = (side: 'BUY' | 'SELL', statuses: string[]) => ({
      sourceWallet: wallet.toLowerCase(),
      side,
      status: { $in: statuses },
      $or: [{ tokenId }, { conditionId }],
    });

    const [buys, sells] = await Promise.all([
      CopyTrade.aggregate([
        { $match: filter('BUY', ['FILLED', 'PARTIAL', 'EXECUTING']) },
        { $group: { _id: null, total: { $sum: { $cond: [{ $eq: ['$status', 'EXECUTING'] }, '$copyBetUsdc', '$filledUsdc'] } } } },
      ]),
      CopyTrade.aggregate([
        { $match: filter('SELL', ['FILLED', 'PARTIAL']) },
        { $group: { _id: null, total: { $sum: '$filledUsdc' } } },
      ]),
    ]);

    return Math.max(0, (buys[0]?.total ?? 0) - (sells[0]?.total ?? 0));
  }

  private async getTraderTotalBoughtShares(wallet: string, tokenId: string, conditionId: string): Promise<number> {
    const byToken = await CopyTrade.aggregate([
      { $match: { sourceWallet: wallet, side: 'BUY', status: { $in: ['FILLED', 'EXECUTING'] }, tokenId } },
      { $group: { _id: null, total: { $sum: '$traderSize' } } },
    ]);
    if (byToken[0]?.total > 0) return byToken[0].total;

    const byCond = await CopyTrade.aggregate([
      { $match: { sourceWallet: wallet, side: 'BUY', status: { $in: ['FILLED', 'EXECUTING'] }, conditionId } },
      { $group: { _id: null, total: { $sum: '$traderSize' } } },
    ]);
    return byCond[0]?.total ?? 0;
  }
}
