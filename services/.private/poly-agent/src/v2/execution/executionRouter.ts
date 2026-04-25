/**
 * ExecutionRouter — routes trades to the correct executor by strategy.
 *
 * Strategy resolution (highest to lowest priority):
 *   1. Per-token override set via setStrategy(tokenId, strategy)
 *   2. Per-exchange override set via setExchangeStrategy(exchange, strategy)
 *   3. Global default strategy (env EXECUTION_STRATEGY or constructor arg)
 *   4. 'auto' fallback: NEG_RISK → market, CTF → gtd
 *
 * Switching strategies requires no restart:
 *   router.setStrategy('0xabc...', 'market')   // one token
 *   router.setExchangeStrategy('CTF', 'market') // all CTF markets
 *   router.setGlobalStrategy('market')          // everything
 *   router.clearOverride('0xabc...')            // remove token override
 *
 * Executors are injected at construction so they can be swapped in tests
 * or replaced independently without touching the router.
 */

import { RoutedTrade, ExecutionStrategy } from '../types';

export type ResolvedStrategy = 'market' | 'gtd';

export interface IExecutor {
  execute(trade: RoutedTrade): Promise<void>;
}

export class ExecutionRouter {
  // Per-token overrides — highest priority
  private tokenOverrides    = new Map<string, ResolvedStrategy>();
  // Per-exchange overrides
  private exchangeOverrides = new Map<'CTF' | 'NEG_RISK', ResolvedStrategy>();
  // Global default
  private globalStrategy: ExecutionStrategy;

  constructor(
    private readonly marketExecutor: IExecutor,
    private readonly gtdExecutor:    IExecutor,
    defaultStrategy: ExecutionStrategy = 'auto',
  ) {
    this.globalStrategy = defaultStrategy;
  }

  // ── Override controls (no restart needed) ──────────────────────────────────

  setGlobalStrategy(strategy: ExecutionStrategy): void {
    this.globalStrategy = strategy;
    console.log(`[ExecutionRouter] Global strategy → ${strategy}`);
  }

  setStrategy(tokenId: string, strategy: ResolvedStrategy): void {
    this.tokenOverrides.set(tokenId.toLowerCase(), strategy);
    console.log(`[ExecutionRouter] Token ${tokenId.slice(0, 12)}... → ${strategy}`);
  }

  setExchangeStrategy(exchange: 'CTF' | 'NEG_RISK', strategy: ResolvedStrategy): void {
    this.exchangeOverrides.set(exchange, strategy);
    console.log(`[ExecutionRouter] ${exchange} exchange → ${strategy}`);
  }

  clearOverride(tokenId: string): void {
    this.tokenOverrides.delete(tokenId.toLowerCase());
    console.log(`[ExecutionRouter] Cleared override for ${tokenId.slice(0, 12)}...`);
  }

  clearExchangeOverride(exchange: 'CTF' | 'NEG_RISK'): void {
    this.exchangeOverrides.delete(exchange);
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  resolve(tokenId: string, exchange: 'CTF' | 'NEG_RISK'): ResolvedStrategy {
    // 1. Per-token
    const tokenOverride = this.tokenOverrides.get(tokenId.toLowerCase());
    if (tokenOverride) return tokenOverride;

    // 2. Per-exchange
    const exchangeOverride = this.exchangeOverrides.get(exchange);
    if (exchangeOverride) return exchangeOverride;

    // 3. Global
    if (this.globalStrategy === 'market') return 'market';
    if (this.globalStrategy === 'gtd')    return 'gtd';

    // 4. Auto: NEG_RISK → market orders (fast fill for geopolitical),
    //          CTF     → GTD maker (price discovery, spread-proportional aggression)
    return exchange === 'NEG_RISK' ? 'market' : 'gtd';
  }

  async route(trade: RoutedTrade): Promise<void> {
    const executor = trade.strategy === 'market'
      ? this.marketExecutor
      : this.gtdExecutor;

    await executor.execute(trade);
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  status(): {
    globalStrategy:    ExecutionStrategy;
    tokenOverrides:    Record<string, ResolvedStrategy>;
    exchangeOverrides: Record<string, ResolvedStrategy>;
  } {
    return {
      globalStrategy:    this.globalStrategy,
      tokenOverrides:    Object.fromEntries(this.tokenOverrides),
      exchangeOverrides: Object.fromEntries(this.exchangeOverrides),
    };
  }
}
