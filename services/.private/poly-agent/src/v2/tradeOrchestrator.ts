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
  clobHost:      string;    // 'https://clob.polymarket.com' (or v2 test endpoint)
  privateKey:    string;
  apiKey:        string;
  apiSecret:     string;
  passphrase:    string;
  polygonRpc:    string;
  botAddress:    string;

  // WS User Channel
  wssUserUrl:    string;

  // Safety
  maxDriftPct:   number;    // e.g. 0.05 (5%)
  maxSpreadPct:  number;    // e.g. 0.10 (10%)

  // Execution
  maxMarketAttempts: number;  // FAK retries (default 5)
  maxGtdAttempts:    number;  // GTD retries (default 3)
  defaultStrategy:   ExecutionStrategy;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class TradeOrchestrator {
  readonly router: ExecutionRouter;

  private detector:  OnChainDetector;
  private books:     OrderbookCacheV2;
  private fillTracker: FillTrackerV2;

  // Concurrent trade guards (synchronous — no await between check and set)
  private positionReserved = new Map<string, number>();  // `wallet:conditionId` → USDC reserved
  private sellInProgress   = new Set<string>();          // tokenId

  private constructor(
    detector:    OnChainDetector,
    books:       OrderbookCacheV2,
    fillTracker: FillTrackerV2,
    router:      ExecutionRouter,
  ) {
    this.detector    = detector;
    this.books       = books;
    this.fillTracker = fillTracker;
    this.router      = router;
  }

  static async create(cfg: OrchestratorConfig): Promise<TradeOrchestrator> {
    const clob = await ClobV2Client.create({
      host:       cfg.clobHost,
      privateKey: cfg.privateKey,
      apiKey:     cfg.apiKey,
      apiSecret:  cfg.apiSecret,
      passphrase: cfg.passphrase,
      polygonRpc: cfg.polygonRpc,
    });

    const books      = new OrderbookCacheV2(cfg.clobHost);
    const safety     = new SafetyGuard(cfg.maxDriftPct, cfg.maxSpreadPct);
    const resolver   = new MarketMetaResolver(cfg.clobHost);
    const recorder   = new TradeRecorder();
    const fillTracker = new FillTrackerV2(
      cfg.wssUserUrl, cfg.apiKey, cfg.apiSecret, cfg.passphrase, cfg.botAddress
    );

    const marketExec = new MarketOrderExecutor(clob, books, safety, recorder, cfg.maxMarketAttempts);
    const gtdExec    = new GTDExecutorV2(clob, books, safety, recorder, fillTracker, cfg.maxGtdAttempts);

    const router = new ExecutionRouter(marketExec, gtdExec, cfg.defaultStrategy);

    const detector = new OnChainDetector({
      wsUrl:    cfg.polygonWsUrl,
      httpUrl:  cfg.polygonHttpUrl,
      mongoUri: cfg.mongoUri,
      dbName:   cfg.dbName,
    });

    const orchestrator = new TradeOrchestrator(detector, books, fillTracker, router);

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
    this.fillTracker.connect();
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
    // ── 0. Skip stale events (backlog replay on reconnect) ─────────────────
    if (trade.isStale) return;

    // ── 1. Prefetch orderbook in parallel with everything below ───────────
    this.books.prefetch(trade.tokenId);

    // ── 2. Resolve market metadata ────────────────────────────────────────
    const meta = await resolver.resolve(trade.tokenId, trade.exchange === 'NEG_RISK');
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
      if (err.code === 11000) return; // already processed
      throw err;
    }

    // ── 5. Resolve execution strategy ─────────────────────────────────────
    const strategy = this.router.resolve(trade.tokenId, trade.exchange);

    // ── 6. SELL path ───────────────────────────────────────────────────────
    if (trade.side === 'SELL') {
      await this.handleSell(trade, meta, trader, strategy, recorder);
      return;
    }

    // ── 7. BUY: bet sizing ────────────────────────────────────────────────
    const sizing = calcCopyBet(trade.usdcAmount, trader);
    if (sizing.skip) {
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
      await recorder.skip({ ...trade, meta, strategy, copyBetUsdc: sizing.betUsdc } as RoutedTrade, 'POSITION_CAP_FULL');
      return;
    }

    const copyBetUsdc = Math.min(sizing.betUsdc, positionAvail);

    // Release reservation after DB write (reservation was worst-case)
    try {
      // Update doc with resolved bet size
      await CopyTrade.updateOne({ txHash: trade.txHash }, { $set: { copyBetUsdc, status: 'EXECUTING' } });
    } finally {
      const cur = this.positionReserved.get(lockKey) ?? 0;
      const upd = Math.max(0, cur - sizing.betUsdc);
      if (upd === 0) this.positionReserved.delete(lockKey); else this.positionReserved.set(lockKey, upd);
    }

    const ts = new Date().toISOString().slice(11, 19);
    const lagSec = Math.max(0, trade.lagMs / 1000).toFixed(2);
    const ratio  = (trade.usdcAmount / trader.avgBet).toFixed(1);
    console.log(
      `\n[${ts}] ${trader.label} ${trade.side} $${trade.usdcAmount.toFixed(0)}` +
      ` "${meta.title.slice(0, 40)}" lag=${lagSec}s | ×${ratio} avg → copy $${copyBetUsdc.toFixed(2)}` +
      ` [${strategy.toUpperCase()}]`
    );

    // ── 9. Route to executor ───────────────────────────────────────────────
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
