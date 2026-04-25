/**
 * TradeRecorder — all MongoDB writes for v2 trade lifecycle.
 *
 * Centralises every DB write in one place so executors stay logic-only.
 * Uses the existing CopyTrade model — v2 trades are stored in the same
 * collection as v1 to keep analytics and position cap queries unified.
 *
 * New field: transactionId (CLOBv2 returns transactionID, not txHash in
 * submit response). Both are stored when available.
 */

import { CopyTrade } from '../../db/models/CopyTrade';
import { TraderLoader } from '../../modules/traderLoader';
import { RoutedTrade, ExecutionResult } from '../types';
import type { SkipReason } from '../../db/models/CopyTrade';

export class TradeRecorder {
  /**
   * Create the initial DETECTED record. Returns the doc _id as a string.
   * Throws on duplicate txHash (MongoDB unique index) — caller treats as dedup.
   */
  async createDetected(trade: RoutedTrade): Promise<string> {
    const doc = await CopyTrade.create({
      sourceWallet:       trade.wallet,
      traderLabel:        trade.label,
      txHash:             trade.txHash,
      conditionId:        trade.meta.conditionId,
      tokenId:            trade.tokenId,
      title:              trade.meta.title,
      outcome:            trade.meta.outcome,
      side:               trade.side,
      traderBetUsdc:      trade.usdcAmount,
      traderPrice:        trade.impliedPrice,
      traderSize:         trade.tokenAmount,
      traderTs:           trade.blockTimestampMs,
      detectedAt:         trade.receivedAtMs,
      discoveryLatencyMs: trade.lagMs < 0 ? 0 : trade.lagMs,
      copyBetUsdc:        trade.copyBetUsdc,
      status:             'DETECTED',
    });
    await TraderLoader.recordDetected(trade.wallet);
    return doc._id.toString();
  }

  /**
   * Mark trade as SKIPPED with a reason code and optional detail.
   */
  async skip(trade: RoutedTrade, reason: SkipReason, detail?: string): Promise<void> {
    await CopyTrade.updateOne(
      { txHash: trade.txHash },
      { $set: { status: 'SKIPPED', skipReason: reason, skipDetail: detail } },
    );
    await TraderLoader.recordSkip(trade.wallet, reason);
  }

  /**
   * Mark trade as FAILED (after order attempt(s)).
   * Preserves any partial fill data from completed attempts.
   */
  async fail(
    trade:    RoutedTrade,
    reason:   SkipReason,
    detail:   string,
    attempts: ExecutionResult['attempts'],
    startMs:  number,
  ): Promise<void> {
    const partialFilled = attempts.reduce((s, a) => s + a.filledShares, 0);
    const partialUsdc   = attempts.reduce((s, a) => s + a.filledUsdc,   0);

    await CopyTrade.updateOne(
      { txHash: trade.txHash },
      {
        $set: {
          status:     partialFilled > 0 ? 'PARTIAL' : 'FAILED',
          skipReason: reason,
          failReason: detail,
          attempts:   attempts.length,
          filledSize: partialFilled > 0 ? partialFilled : undefined,
          filledUsdc: partialUsdc   > 0 ? partialUsdc   : undefined,
        },
      },
    );
    await TraderLoader.recordSkip(trade.wallet, reason);
  }

  /**
   * Mark trade as FILLED with full execution result.
   */
  async complete(trade: RoutedTrade, result: ExecutionResult): Promise<void> {
    const filledAt   = Date.now();
    const lastAttempt = result.attempts[result.attempts.length - 1];

    await CopyTrade.updateOne(
      { txHash: trade.txHash },
      {
        $set: {
          status:              result.totalFilled > 0 ? 'FILLED' : 'FAILED',
          orderId:             lastAttempt?.orderId,
          filledSize:          result.totalFilled,
          avgFillPrice:        result.avgPrice,
          filledUsdc:          result.totalUsdc,
          attempts:            result.attempts.length,
          submittedAt:         result.attempts[0]?.submittedAtMs,
          submissionLatencyMs: result.attempts[0]
            ? result.attempts[0].submittedAtMs - trade.receivedAtMs
            : undefined,
          filledAt,
          fillLatencyMs:   filledAt - (result.attempts[0]?.submittedAtMs ?? filledAt),
          totalLatencyMs:  filledAt - trade.receivedAtMs,
          priceDrift:      result.avgPrice > 0 && trade.impliedPrice > 0
            ? (result.avgPrice - trade.impliedPrice) / trade.impliedPrice
            : undefined,
        },
      },
    );

    if (result.totalUsdc > 0) {
      await TraderLoader.recordFill(trade.wallet, result.totalUsdc);
    }
  }

  /**
   * Fail a trade by its MongoDB _id (used in GTD retry path where
   * we only have the PendingOrderV2, not the original RoutedTrade).
   */
  async failById(
    tradeDocId:   string,
    reason:       SkipReason,
    detail:       string,
    filledShares: number,
    filledUsdc:   number,
  ): Promise<void> {
    await CopyTrade.findByIdAndUpdate(tradeDocId, {
      $set: {
        status:     filledShares > 0 ? 'PARTIAL' : 'FAILED',
        skipReason: reason,
        failReason: detail,
        filledSize: filledShares > 0 ? filledShares : undefined,
        filledUsdc: filledUsdc   > 0 ? filledUsdc   : undefined,
      },
    });
  }
}
