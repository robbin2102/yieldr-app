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
  // Per-exchange overrides (v1 and v2 variants addressable separately)
  private exchangeOverrides = new Map<RoutedTrade['exchange'], ResolvedStrategy>();
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

  setExchangeStrategy(exchange: RoutedTrade['exchange'], strategy: ResolvedStrategy): void {
    this.exchangeOverrides.set(exchange, strategy);
    console.log(`[ExecutionRouter] ${exchange} exchange → ${strategy}`);
  }

  clearOverride(tokenId: string): void {
    this.tokenOverrides.delete(tokenId.toLowerCase());
    console.log(`[ExecutionRouter] Cleared override for ${tokenId.slice(0, 12)}...`);
  }

  clearExchangeOverride(exchange: RoutedTrade['exchange']): void {
    this.exchangeOverrides.delete(exchange);
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  resolve(tokenId: string, exchange: RoutedTrade['exchange']): ResolvedStrategy {
    // 1. Per-token
    const tokenOverride = this.tokenOverrides.get(tokenId.toLowerCase());
    if (tokenOverride) return tokenOverride;

    // 2. Per-exchange
    const exchangeOverride = this.exchangeOverrides.get(exchange);
    if (exchangeOverride) return exchangeOverride;

    // 3. Global
    if (this.globalStrategy === 'market') return 'market';
    if (this.globalStrategy === 'gtd')    return 'gtd';

    // 4. Auto: NEG_RISK variants → market (fast fill for geopolitical),
    //          CTF variants      → GTD maker (price discovery)
    return (exchange === 'NEG_RISK' || exchange === 'NEG_RISK_V2') ? 'market' : 'gtd';
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
