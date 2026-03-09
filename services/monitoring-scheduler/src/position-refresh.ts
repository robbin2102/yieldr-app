import { config } from './config';
import { logger } from './utils/logger';
import { callMCPTool } from './tool-caller';
import { upsertUserPositions, getActiveMonitoringUserIds } from './db/positions';

/**
 * Position Refresh Service
 *
 * Keeps user position data fresh so the evaluator LLM has accurate context.
 *
 * Schedules:
 *   - Every 2 min: Hyperliquid (batch) + Polymarket (per wallet)
 *   - Every 10 min: Avantis (RPC cost, fewer refreshes)
 *
 * Only refreshes positions for users with active monitoring tasks.
 * Skips platforms a user has no data for — no-op, no error.
 */

// userId in monitoring_tasks is always the wallet address (0x...).
// Skip any non-address values (e.g. test data) to avoid invalid-address errors.
function isWalletAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// ─── Hyperliquid ──────────────────────────────────────────────────────────────

async function refreshHyperliquidPositions(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;

  for (const userId of userIds) {
    if (!isWalletAddress(userId)) {
      logger.debug('PositionRefresh', `Skipping HL refresh for non-address userId: ${userId}`);
      continue;
    }
    try {
      const result = await callMCPTool('get_hl_live_positions', {
        walletAddress: userId,
      });

      if (!result || result.totalPositions === 0) continue;

      const positions = (result.positions ?? []).map((p: any) => ({
        asset: p.coin,
        direction: p.side,
        size: p.size,
        pnl: p.unrealizedPnl,
        platform: 'hyperliquid',
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        leverage: p.leverage,
        liquidationPrice: p.liquidationPrice,
        marginUsed: p.marginUsed,
        roi: p.roi,
      }));

      await upsertUserPositions({
        userId: userId.toLowerCase(),
        platform: 'hyperliquid',
        positions,
        accountValue: result.summary?.accountValue,
        lastUpdated: new Date(),
      });
    } catch (err: any) {
      logger.debug('PositionRefresh', `HL refresh failed for ${userId}: ${err.message}`);
    }
  }

  logger.debug('PositionRefresh', `HL: refreshed ${userIds.length} wallets`);
}

// ─── Polymarket ───────────────────────────────────────────────────────────────

async function refreshPolymarketPositions(userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    if (!isWalletAddress(userId)) {
      logger.debug('PositionRefresh', `Skipping PM refresh for non-address userId: ${userId}`);
      continue;
    }
    try {
      const result = await callMCPTool('get_pm_live_positions', {
        walletAddress: userId,
      });

      if (!result || result.totalPositions === 0) continue;

      const positions = (result.positions ?? []).map((p: any) => ({
        asset: p.title,
        direction: p.outcome,
        size: p.size,
        pnl: p.pnl,
        platform: 'polymarket',
        outcome: p.outcome,
        avgPrice: p.avgPrice,
        currentValue: p.currentValue,
        pnlPercent: p.pnlPercent,
      }));

      await upsertUserPositions({
        userId: userId.toLowerCase(),
        platform: 'polymarket',
        positions,
        totalPnl: result.summary?.totalPnL,
        lastUpdated: new Date(),
      });
    } catch (err: any) {
      // Per-wallet failure is non-fatal — skip and continue
      logger.debug('PositionRefresh', `PM refresh failed for ${userId}: ${err.message}`);
    }
  }

  logger.debug('PositionRefresh', `PM: refreshed ${userIds.length} wallets`);
}

// ─── Avantis ─────────────────────────────────────────────────────────────────

async function refreshAvantisPositions(userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    if (!isWalletAddress(userId)) {
      logger.debug('PositionRefresh', `Skipping Avantis refresh for non-address userId: ${userId}`);
      continue;
    }
    try {
      const result = await callMCPTool('get_avantis_live_positions', {
        walletAddress: userId,
      });

      if (!result || result.totalPositions === 0) continue;

      const positions = (result.positions ?? []).map((p: any) => ({
        asset: p.pair,
        direction: p.direction,
        size: p.positionSize,
        pnl: p.pnl,
        platform: 'avantis',
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        leverage: p.leverage,
        liquidationPrice: p.liquidationPrice,
        marginUsed: p.margin,
        roi: p.roi,
      }));

      await upsertUserPositions({
        userId: userId.toLowerCase(),
        platform: 'avantis',
        positions,
        totalPnl: result.summary?.totalPnL,
        lastUpdated: new Date(),
      });
    } catch (err: any) {
      logger.debug('PositionRefresh', `Avantis refresh failed for ${userId}: ${err.message}`);
    }
  }

  logger.debug('PositionRefresh', `Avantis: refreshed ${userIds.length} wallets`);
}

// ─── Refresh Cycles ───────────────────────────────────────────────────────────

async function runFastRefreshCycle(): Promise<void> {
  try {
    const userIds = await getActiveMonitoringUserIds();
    if (userIds.length === 0) return;

    await Promise.all([
      refreshHyperliquidPositions(userIds),
      refreshPolymarketPositions(userIds),
    ]);
  } catch (err: any) {
    logger.warn('PositionRefresh', `Fast cycle error: ${err.message}`);
  }
}

async function runAvantisRefreshCycle(): Promise<void> {
  try {
    const userIds = await getActiveMonitoringUserIds();
    if (userIds.length === 0) return;
    await refreshAvantisPositions(userIds);
  } catch (err: any) {
    logger.warn('PositionRefresh', `Avantis cycle error: ${err.message}`);
  }
}

// ─── Public: start loops ──────────────────────────────────────────────────────

export function startPositionRefresh(): void {
  logger.info('PositionRefresh', `Starting — HL/PM every ${config.positionRefreshMs / 1000}s, Avantis every ${config.avantisRefreshMs / 1000}s`);

  // Run immediately on start, then on interval
  runFastRefreshCycle();
  setInterval(runFastRefreshCycle, config.positionRefreshMs);

  runAvantisRefreshCycle();
  setInterval(runAvantisRefreshCycle, config.avantisRefreshMs);
}
