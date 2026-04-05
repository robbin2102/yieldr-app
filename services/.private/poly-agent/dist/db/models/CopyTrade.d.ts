import mongoose, { Document } from 'mongoose';
/**
 * Skip reason codes — every skip is logged for post-analysis.
 *
 * BELOW_AVG        — trader bet < avgBet (conviction filter)
 * ALLOCATION_FULL  — trader's allocationUsdc exhausted
 * NO_ORDERBOOK     — failed to fetch orderbook
 * SELL_NO_POSITION — copying SELL but we have no matching position
 * DUPLICATE        — txHash already processed
 * ORDER_FAILED     — GTT failed after all retries
 * NON_TRADE        — activity type was REDEEM/MERGE/SPLIT
 */
export type SkipReason = 'BELOW_AVG' | 'ALLOCATION_FULL' | 'NO_ORDERBOOK' | 'SELL_NO_POSITION' | 'DUPLICATE' | 'ORDER_FAILED' | 'NON_TRADE';
export type TradeStatus = 'DETECTED' | 'SKIPPED' | 'EXECUTING' | 'FILLED' | 'PARTIAL' | 'FAILED';
export interface ICopyTrade extends Document {
    sourceWallet: string;
    traderLabel: string;
    txHash: string;
    conditionId: string;
    tokenId: string;
    title: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    traderBetUsdc: number;
    traderPrice: number;
    traderSize: number;
    copyBetUsdc: number;
    skipReason?: SkipReason;
    skipDetail?: string;
    traderTs: number;
    detectedAt: number;
    discoveryLatencyMs: number;
    orderId?: string;
    submittedAt?: number;
    submissionLatencyMs?: number;
    filledAt?: number;
    fillLatencyMs?: number;
    totalLatencyMs?: number;
    filledSize?: number;
    avgFillPrice?: number;
    filledUsdc?: number;
    priceDrift?: number;
    attempts?: number;
    status: TradeStatus;
    failReason?: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare const CopyTrade: mongoose.Model<ICopyTrade, {}, {}, {}, mongoose.Document<unknown, {}, ICopyTrade, {}, {}> & ICopyTrade & Required<{
    _id: mongoose.Types.ObjectId;
}> & {
    __v: number;
}, any>;
